import * as admin from "firebase-admin";
import { sendMessage, getOrCreateSession } from "../linq/client";
import { notifyAdminBookingConfirmed } from "../notifications";
import { logBookingCreated } from "../observability/auditLog";
import { closeJobPost } from "../triggers/jobNotifications";

async function hasConflict(
  caregiverId: string,
  date: string,
  startTime: string,
  endTime: string
): Promise<boolean> {
  const snap = await db.collection("appointments")
    .where("caregiverId", "==", caregiverId)
    .where("date", "==", date)
    .where("status", "in", ["confirmed", "pending_caregiver_confirmation"])
    .get();
  return snap.docs.some((doc) => {
    const d = doc.data();
    return d.startTime < endTime && d.endTime > startTime;
  });
}

const db = admin.firestore();

interface BookingAppointment {
  date:          string;
  startTime:     string;
  endTime:       string;
  durationHours: number;
}

interface BookingTask {
  type:          "booking_confirmation" | "cancellation_confirmation" | "rebook_confirmation";
  clientId:      string;
  clientPhone:   string;
  caregiverId:   string;
  caregiverName: string;
  appointments:  BookingAppointment[];
  totalCost:     number;
  status:        "awaiting_approval" | "approved" | "declined" | "expired";
  humanApproved: boolean;
  expiresAt:     string;
  createdAt:     string;
  agentTaskId?:  string;
}

export async function executeBookings(taskId: string, clientPhone: string): Promise<void> {
  const taskRef  = db.collection("agent_tasks").doc(taskId);
  const taskSnap = await taskRef.get();

  if (!taskSnap.exists) throw new Error(`agent_tasks/${taskId} not found`);

  const task = taskSnap.data() as BookingTask;

  if (task.status !== "awaiting_approval") return; // Already processed
  if (new Date(task.expiresAt) < new Date()) {
    await taskRef.update({ status: "expired" });
    const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
    if (sessionSnap.exists) {
      await sendMessage(sessionSnap.data()!.chatId,
        `The booking for ${task.caregiverName} timed out. Those expire after 2 hours to keep availability current.\n\n` +
        `Want me to start it again? Reply YES and I'll pull up where we left off.`
      );
    }
    return;
  }

  const now = new Date().toISOString();

  // Check for scheduling conflicts before writing anything
  for (const appt of task.appointments) {
    if (await hasConflict(task.caregiverId, appt.date, appt.startTime, appt.endTime)) {
      await taskRef.update({ status: "conflict_detected" });
      const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
      if (sessionSnap.exists) {
        await sendMessage(sessionSnap.data()!.chatId,
          `I couldn't complete the booking — ${task.caregiverName} already has a visit at that time.\n\n` +
          `Reply YES and I'll search for a different caregiver.`
        );
      }
      await db.collection("admin_alerts").add({
        type:          "booking_conflict",
        caregiverId:   task.caregiverId,
        caregiverName: task.caregiverName,
        clientPhone,
        date:          appt.date,
        startTime:     appt.startTime,
        endTime:       appt.endTime,
        createdAt:     now,
        resolved:      false,
      });
      return;
    }
  }

  // Write each appointment — this is the ONLY place appointments are written by the agent
  const batch = db.batch();
  const apptRefs: admin.firestore.DocumentReference[] = [];

  for (const appt of task.appointments) {
    const ref = db.collection("appointments").doc();
    apptRefs.push(ref);
    batch.set(ref, {
      clientId:        task.clientId,
      caregiverId:     task.caregiverId,
      caregiverName:   task.caregiverName,
      date:            appt.date,
      startTime:       appt.startTime,
      endTime:         appt.endTime,
      durationHours:   appt.durationHours,
      status:          "confirmed",
      createdByAgent:  true,
      agentTaskId:     taskId,
      humanApproved:   true,
      approvedAt:      now,
      createdAt:       now,
    });
  }

  batch.update(taskRef, { status: "approved", humanApproved: true, approvedAt: now });
  await batch.commit();

  await closeJobPost(task.clientId).catch((err) =>
    console.error("[executeBookings] closeJobPost failed:", err)
  );

  logBookingCreated(
    task.clientId,
    task.caregiverId,
    task.appointments.map((a) => a.date)
  ).catch(() => {});

  notifyAdminBookingConfirmed({
    taskId:           taskId,
    caregiverName:    task.caregiverName,
    clientPhone:      clientPhone,
    appointmentCount: task.appointments.length,
    totalCost:        task.totalCost,
  }).catch((err) => console.error("notifyAdminBookingConfirmed error:", err));

  const appUrl = process.env.APP_URL ?? "https://cara.app";

  // Confirm to family
  const sessionSnap = await db.collection("agent_sessions").doc(clientPhone).get();
  if (sessionSnap.exists) {
    const lines = task.appointments.map((a) =>
      `${a.date} · ${a.startTime}–${a.endTime} · ${task.caregiverName}`
    ).join("\n");

    await sendMessage(sessionSnap.data()!.chatId,
      `All booked! Here's your confirmed schedule:\n\n` +
      `${lines}\n\n` +
      `I'll text you when ${task.caregiverName} arrives for the first visit.\n` +
      `View your schedule: ${appUrl}/client/schedule\n\n` +
      `Any questions? Just text me.`
    );

    // Check if client has a payment method — if not, send a Stripe setup link
    try {
      const Stripe = (await import("stripe")).default;
      const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY ?? "");
      const clientSnap   = await db.collection("users").doc(task.clientId ?? "").get();
      const stripeCustomerId = clientSnap.data()?.stripeCustomerId as string | undefined;

      let hasPaymentMethod = false;
      if (stripeCustomerId) {
        const customer = await stripeClient.customers.retrieve(stripeCustomerId) as any;
        hasPaymentMethod = !!(
          customer.invoice_settings?.default_payment_method ||
          customer.default_source
        );
      }

      if (!hasPaymentMethod) {
        const { generateToken } = await import("./tokenService");
        const token    = generateToken({ phone: clientPhone, task: "payment" });
        const setupUrl = `${appUrl}/done?task=payment&t=${token}`;
        await sendMessage(sessionSnap.data()!.chatId,
          `One more thing — to pay ${task.caregiverName} after each visit, ` +
          `add a card on file (takes 30 seconds): ${setupUrl}`
        );
      }
    } catch (err) {
      console.error("bookingExecutor payment method check error:", err);
    }
  }

  // Notify caregiver
  const [caregiverSnap, clientSnap] = await Promise.all([
    db.collection("caregivers").doc(task.caregiverId).get(),
    db.collection("users").doc(task.clientId).get(),
  ]);
  const cgPhone   = caregiverSnap.data()?.phone as string | undefined;
  const seniorName = clientSnap.data()?.seniorName
    ?? (clientSnap.data()?.senior as any)?.name
    ?? null;
  if (cgPhone) {
    const cgSession  = await getOrCreateSession(cgPhone, { caregiverId: task.caregiverId });
    const firstAppt  = task.appointments[0];
    const visitPay   = ((caregiverSnap.data()?.hourlyRate ?? 20) * firstAppt.durationHours).toFixed(2);
    const clientLabel = seniorName ? `with ${seniorName as string}` : "with your client";
    await sendMessage(cgSession.chatId,
      `You're booked ${clientLabel} starting ${firstAppt.date} at ${firstAppt.startTime}.\n\n` +
      `$${visitPay} per visit, paid automatically after each one.\n\n` +
      `I'll text you the care plan and directions the morning of every visit.`
    );
  }
}

// ── Create a booking task (called from webhooks/agents) ───────────────────────

export async function createBookingTask(params: {
  clientPhone:   string;
  clientId:      string;
  caregiverId:   string;
  caregiverName: string;
  appointments:  BookingAppointment[];
  hourlyRate:    number;
}): Promise<string> {
  // Block booking if caregiver's background check is still pending
  const cgSnap = await db.collection("caregivers").doc(params.caregiverId).get();
  const cgStatus = cgSnap.data()?.status as string | undefined;
  if (cgStatus === "pending_review") {
    const submittedAt = cgSnap.data()?.backgroundCheckData?.submittedAt as string | undefined;
    const daysInReview = submittedAt
      ? Math.ceil((Date.now() - new Date(submittedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const sessionSnap = await db.collection("agent_sessions").doc(params.clientPhone).get();
    const chatId      = sessionSnap.data()?.chatId as string | undefined;
    if (chatId) {
      await sendMessage(chatId,
        `${params.caregiverName}'s background check is still in progress ` +
        `(${daysInReview > 0 ? `${daysInReview} day${daysInReview !== 1 ? "s" : ""} in review` : "just submitted"}).\n\n` +
        `I'll notify you the moment it clears so you can book. Want me to find another available caregiver in the meantime?`
      );
    }
    return ""; // Early return — no booking written
  }

  const totalCost = params.appointments.reduce(
    (sum, a) => sum + params.hourlyRate * a.durationHours, 0
  );

  const now = new Date();
  const ref = await db.collection("agent_tasks").add({
    type:          "booking_confirmation",
    clientPhone:   params.clientPhone,
    clientId:      params.clientId,
    caregiverId:   params.caregiverId,
    caregiverName: params.caregiverName,
    appointments:  params.appointments,
    totalCost,
    status:        "awaiting_approval",
    humanApproved: false,
    expiresAt:     new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    createdAt:     now.toISOString(),
  });
  return ref.id;
}
