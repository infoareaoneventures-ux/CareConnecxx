import * as functions from "firebase-functions/v1";
import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logAudit } from './observability/auditLog';
import { sendTransactionalEmail } from './email';

if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();
const storage = admin.storage();

// Tax/fee rates are env-driven with safe fallbacks. Values must be a fraction
// in [0, 1] (e.g. "0.05" = 5%) — anything else falls back to the default.
function envRate(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
const TAX_RATE = envRate('INVOICE_TAX_RATE', 0.05);
const PLATFORM_FEE_RATE = envRate('INVOICE_PLATFORM_FEE_RATE', 0.02);

// Signed PDF URLs expire after 7 days; regenerate via generateInvoicePDF.
const PDF_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Mirrors firestore.rules isAdmin(): userType == 'admin' OR isAdmin == true
async function requireAdmin(uid: string) {
    const userDoc = await db.collection('users').doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : undefined;
    if (userData?.userType !== 'admin' && userData?.isAdmin !== true) {
        throw new functions.https.HttpsError('permission-denied', 'Admin access required');
    }
}

// 1. createInvoice (admin only)
export const createInvoice = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    }
    await requireAdmin(context.auth.uid);

    const { clientId, caregiverId, carePeriod, lineItems, notes, dueDate } = data;

    try {
        const clientDoc = await db.collection('users').doc(clientId).get();
        const caregiverDoc = await db.collection('caregivers').doc(caregiverId).get();

        if (!clientDoc.exists || !caregiverDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Client or Caregiver not found');
        }

        const clientData = clientDoc.data() || {};
        const caregiverData = caregiverDoc.data() || {};

        let subtotal = 0;
        for (const item of lineItems) {
            subtotal += item.hours * item.rate;
        }
        const taxes = subtotal * TAX_RATE;
        const fees = subtotal * PLATFORM_FEE_RATE;
        const total = subtotal + taxes + fees;

        const invoiceNumber = `INV-${Date.now()}`;

        const invoice = {
            clientId,
            clientName: clientData.name || clientData.firstName + ' ' + clientData.lastName,
            caregiverId,
            caregiverName: caregiverData.name || caregiverData.firstName + ' ' + caregiverData.lastName,
            invoiceNumber,
            status: 'pending',
            carePeriod,
            lineItems,
            subtotal,
            taxes,
            fees,
            total,
            createdAt: new Date().toISOString(),
            dueDate,
            notes: notes || '',
        };

        const invoiceRef = await db.collection('invoices').add(invoice);

        // Auto-generate PDF
        await generateInvoicePDFLogic(invoiceRef.id);

        await logAudit({
            eventType: 'invoice_created',
            userId: context.auth.uid,
            data: { invoiceId: invoiceRef.id, invoiceNumber, clientId, caregiverId, total },
        });

        return { success: true, invoiceId: invoiceRef.id };

    } catch (error: any) {
        if (error instanceof functions.https.HttpsError) throw error;
        console.error("Error creating invoice:", error);
        throw new functions.https.HttpsError('internal', 'Could not create invoice', error.message);
    }
});

// Helper for generating PDF
async function generateInvoicePDFLogic(invoiceId: string) {
    const invoiceRef = db.collection('invoices').doc(invoiceId);
    const invoiceDoc = await invoiceRef.get();
    if (!invoiceDoc.exists) {
        throw new Error('Invoice not found');
    }
    const invoiceData: any = invoiceDoc.data();

    // Use require for PDFKit to avoid default export issues
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    
    const filePath = path.join(os.tmpdir(), `${invoiceId}.pdf`);
    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    // PDF content
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();
    
    doc.fontSize(12).text(`Invoice #: ${invoiceData.invoiceNumber}`);
    doc.text(`Client: ${invoiceData.clientName}`);
    doc.text(`Caregiver: ${invoiceData.caregiverName}`);
    doc.text(`Care Period: ${invoiceData.carePeriod.start} to ${invoiceData.carePeriod.end}`);
    doc.text(`Date: ${new Date(invoiceData.createdAt).toLocaleDateString()}`);
    doc.text(`Due Date: ${new Date(invoiceData.dueDate).toLocaleDateString()}`);
    doc.text(`Status: ${invoiceData.status.toUpperCase()}`);
    
    doc.moveDown();
    doc.text('Payment Summary:');
    doc.text(`Subtotal: $${invoiceData.subtotal.toFixed(2)}`);
    doc.text(`Taxes: $${invoiceData.taxes.toFixed(2)}`);
    doc.text(`Fees: $${invoiceData.fees.toFixed(2)}`);
    doc.text(`Total: $${invoiceData.total.toFixed(2)}`, { stroke: true });

    doc.moveDown();
    doc.text('Shift Breakdown:');
    invoiceData.lineItems.forEach((item: any) => {
        doc.text(`- ${item.date}: ${item.hours} hrs @ $${item.rate}/hr = $${(item.hours * item.rate).toFixed(2)}`);
        if (item.clockIn && item.clockOut) {
            doc.text(`  Time: ${item.clockIn} to ${item.clockOut}`);
        }
        if (item.tasks && item.tasks.length > 0) {
            doc.text(`  Tasks: ${item.tasks.join(', ')}`);
        }
        if (item.notes) {
            doc.text(`  Notes: ${item.notes}`);
        }
    });

    doc.end();

    await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
    });
    
    const bucket = storage.bucket();
    const destination = `invoices/${invoiceId}.pdf`;
    await bucket.upload(filePath, {
        destination,
        metadata: { contentType: 'application/pdf' },
    });

    // Signed URL with a real TTL (7 days) instead of a never-expiring link
    const file = bucket.file(destination);
    const [pdfUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + PDF_URL_TTL_MS
    });

    await invoiceRef.update({ pdfUrl });
    return pdfUrl;
}

// 5. generateInvoicePDF exposed as https call (invoice participants or admin)
export const generateInvoicePDF = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    const { invoiceId } = data;

    const invoiceDoc = await db.collection('invoices').doc(invoiceId).get();
    if (!invoiceDoc.exists) throw new functions.https.HttpsError('not-found', 'Invoice not found');
    const invoiceData = invoiceDoc.data() as any;
    if (invoiceData.clientId !== context.auth.uid && invoiceData.caregiverId !== context.auth.uid) {
        await requireAdmin(context.auth.uid);
    }

    try {
        const pdfUrl = await generateInvoicePDFLogic(invoiceId);
        return { success: true, pdfUrl };
    } catch (error: any) {
        console.error("Error generating PDF:", error);
        throw new functions.https.HttpsError('internal', 'Could not generate PDF', error.message);
    }
});

// 2. sendInvoiceEmail (admin only)
export const sendInvoiceEmail = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    await requireAdmin(context.auth.uid);

    const { invoiceId } = data;
    try {
        const invoiceRef = db.collection('invoices').doc(invoiceId);
        const invoiceDoc = await invoiceRef.get();
        if (!invoiceDoc.exists) throw new functions.https.HttpsError('not-found', 'Invoice not found');
        const invoiceData = invoiceDoc.data() as any;

        const clientDoc = await db.collection('users').doc(invoiceData.clientId).get();
        const clientEmail = clientDoc.data()?.email;
        if (!clientEmail) {
            throw new functions.https.HttpsError('failed-precondition', 'Client has no email address on file');
        }

        const pdfSection = invoiceData.pdfUrl
            ? `<p><a href="${invoiceData.pdfUrl}">View your invoice PDF</a> (link valid for 7 days)</p>`
            : '';
        const html = `
            <h2>CareConnex Invoice ${invoiceData.invoiceNumber}</h2>
            <p>Hi ${invoiceData.clientName || 'there'},</p>
            <p>Your invoice for care services is ready.</p>
            <p>
                <strong>Invoice #:</strong> ${invoiceData.invoiceNumber}<br/>
                <strong>Amount due:</strong> $${(invoiceData.total ?? 0).toFixed(2)}<br/>
                <strong>Due date:</strong> ${invoiceData.dueDate ? new Date(invoiceData.dueDate).toLocaleDateString() : 'N/A'}
            </p>
            ${pdfSection}
            <p>— The CareConnex Team</p>`;

        await sendTransactionalEmail({
            to: clientEmail,
            subject: `CareConnex Invoice ${invoiceData.invoiceNumber}`,
            html,
            from: process.env.INVOICE_EMAIL_FROM,
        });

        console.log(`Sent email for invoice ${invoiceId} to client with PDF: ${invoiceData.pdfUrl || 'none'}`);

        await logAudit({
            eventType: 'invoice_sent',
            userId: context.auth.uid,
            data: { invoiceId, invoiceNumber: invoiceData.invoiceNumber, clientId: invoiceData.clientId },
        });

        return { success: true, message: 'Email sent successfully' };
    } catch (error: any) {
        if (error instanceof functions.https.HttpsError) throw error;
        console.error("Error sending email:", error);
        throw new functions.https.HttpsError('internal', 'Could not send email', error.message);
    }
});

// 3. processClientApproval
export const processClientApproval = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'User must be logged in');
    
    const { invoiceId, status, rejectionReason } = data; // status: 'approved' or 'rejected'

    if (status !== 'approved' && status !== 'rejected') {
        throw new functions.https.HttpsError('invalid-argument', "status must be 'approved' or 'rejected'");
    }

    try {
        const invoiceRef = db.collection('invoices').doc(invoiceId);
        const invoiceDoc = await invoiceRef.get();

        if (!invoiceDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Invoice not found');
        }
        const invoiceData = invoiceDoc.data() as any;

        // Caller must be the invoice's client or an admin
        if (invoiceData.clientId !== context.auth.uid) {
            await requireAdmin(context.auth.uid);
        }

        const updateData: any = {
            status: status
        };

        if (status === 'approved') {
            updateData.approvedAt = new Date().toISOString();
        } else if (status === 'rejected') {
            updateData.rejectedAt = new Date().toISOString();
            updateData.rejectionReason = rejectionReason || 'No reason provided';
        }

        await invoiceRef.update(updateData);

        await logAudit({
            eventType: status === 'approved' ? 'invoice_approved' : 'invoice_rejected',
            userId: context.auth.uid,
            data: {
                invoiceId,
                invoiceNumber: invoiceData.invoiceNumber,
                ...(status === 'rejected' ? { rejectionReason: rejectionReason || 'No reason provided' } : {}),
            },
        });

        return { success: true };
    } catch (error: any) {
        if (error instanceof functions.https.HttpsError) throw error;
        console.error("Error processing approval:", error);
        throw new functions.https.HttpsError('internal', 'Could not process approval', error.message);
    }
});

// 4. autoApproveInvoice (Scheduled for 48-hour auto-approval)
export const autoApproveInvoice = functions.pubsub.schedule('every 1 hours').onRun(async (context) => {
    try {
        const now = new Date();
        const twoDaysAgo = new Date(now.getTime() - (48 * 60 * 60 * 1000));
        
        const snapshot = await db.collection('invoices')
            .where('status', '==', 'pending')
            .where('createdAt', '<=', twoDaysAgo.toISOString())
            .get();

        if (snapshot.empty) {
            return null;
        }

        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            const currentNotes = doc.data().notes || '';
            batch.update(doc.ref, {
                status: 'approved',
                approvedAt: new Date().toISOString(),
                notes: currentNotes + '\n[System]: Auto-approved after 48h window.'
            });
        });

        await batch.commit();
        console.log(`Auto-approved ${snapshot.size} invoices.`);

        await Promise.all(snapshot.docs.map(doc => logAudit({
            eventType: 'invoice_auto_approved',
            userId: 'system',
            data: { invoiceId: doc.id, invoiceNumber: doc.data().invoiceNumber },
        })));

        return null;
    } catch (error) {
        console.error("Error auto-approving invoices:", error);
        return null;
    }
});

// 6. Audit trail for invoice deletion. The admin InvoicingTab deletes the
// Firestore doc directly (firestore.rules restricts that delete to admins),
// so the audit event is recorded via this onDelete trigger.
export const onInvoiceDeleted = functions.firestore
    .document('invoices/{invoiceId}')
    .onDelete(async (snap, context) => {
        const data = snap.data() || {};
        await logAudit({
            eventType: 'invoice_deleted',
            userId: 'system',
            data: {
                invoiceId: context.params.invoiceId,
                invoiceNumber: data.invoiceNumber,
                clientId: data.clientId,
                caregiverId: data.caregiverId,
                total: data.total,
            },
        });
        return null;
    });
