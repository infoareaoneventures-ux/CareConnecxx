import * as admin from "firebase-admin";
import { parseWithClaude } from "../utils/parseWithClaude";
import { generateCaraMessage } from "../utils/caraMessage";

const db = admin.firestore();

async function isQuestionOrOther(text: string): Promise<boolean> {
  const result = await parseWithClaude(
    "Reply YES if this is a general question or off-topic comment unrelated to approving or disputing timesheet hours. Reply NO if it is a direct answer. Only reply YES or NO.",
    text,
    5
  );
  return result.toUpperCase().startsWith("Y");
}

interface PendingTimesheet {
  id:            string;
  caregiverName: string;
  date:          string;
  clockIn:       string;
  clockOut:      string;
  hours:         number;
  amountOwed:    string;
  caregiverId:   string;
  amountCents:   number;
  appointmentId: string;
}

// State flow: start → confirm_one → [done]
export async function handleTimesheetApproval(
  clientId: string,
  phone:    string,
  text:     string,
  session:  Record<string, unknown>,
  sendMessage: (msg: string) => Promise<void>
): Promise<void> {
  const step = (session.timesheetStep as string) ?? "start";

  // ── start — load pending timesheets and ask for approval ─────────────────
  if (step === "start") {
    const snap = await db.collection("shiftHours")
      .where("clientId", "==", clientId)
      .where("status",   "==", "pending_client_review")
      .orderBy("submittedAt", "desc")
      .limit(5)
      .get();

    if (snap.empty) {
      const msg = await generateCaraMessage({
        audience: "family",
        context:  "A family member asked about pending timesheets but there are none waiting for review. Let them know briefly and warmly.",
        fallback:  "No timesheets are waiting for your review right now.",
        maxTokens: 60,
      });
      await sendMessage(msg);
      await db.collection("agent_sessions").doc(phone).update({
        timesheetStep: admin.firestore.FieldValue.delete(),
      }).catch(() => {});
      return;
    }

    const timesheets: PendingTimesheet[] = await Promise.all(
      snap.docs.map(async (d) => {
        const ts = d.data();
        const cgSnap = await db.collection("caregivers").doc(ts.caregiverId as string).get().catch(() => null);
        const cg = cgSnap?.data() ?? {};
        return {
          id:            d.id,
          caregiverName: (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Caregiver",
          date:          ts.date as string,
          clockIn:       ts.clockInTime as string ?? "",
          clockOut:      ts.clockOutTime as string ?? "",
          hours:         Number(ts.durationHours ?? 0),
          amountOwed:    `$${((ts.amountCents as number ?? 0) / 100).toFixed(2)}`,
          amountCents:   ts.amountCents as number ?? 0,
          caregiverId:   ts.caregiverId as string,
          appointmentId: ts.appointmentId as string ?? "",
        };
      })
    );

    // Store list and present first one
    const first = timesheets[0];
    const restIds = timesheets.slice(1).map(t => t.id);

    await db.collection("agent_sessions").doc(phone).update({
      timesheetStep:           "confirm_one",
      pendingTimesheetId:      first.id,
      pendingTimesheetDesc:    JSON.stringify(first),
      pendingTimesheetQueue:   restIds,
      pendingTimesheetSetAt:   new Date().toISOString(),
    });

    const opener = await generateCaraMessage({
      audience:  "family",
      context:   `${first.caregiverName} submitted hours for review for the visit on ${first.date}. Cara is presenting them to the family for approval. Write a brief 1-sentence intro.`,
      fallback:   `${first.caregiverName} submitted their hours for ${first.date} — here are the details:`,
      maxTokens: 60,
    });
    const timeRange = first.clockIn && first.clockOut ? ` (${first.clockIn} – ${first.clockOut})` : "";
    await sendMessage(
      `${opener}\n\n` +
      `Caregiver: ${first.caregiverName}\n` +
      `Date: ${first.date}${timeRange}\n` +
      `Hours worked: ${first.hours}\n` +
      `Amount: ${first.amountOwed}\n\n` +
      `Reply APPROVE to confirm and release payment, or DISPUTE if something looks wrong.`
    );
    return;
  }

  // ── confirm_one — handle APPROVE / DISPUTE ────────────────────────────────
  if (step === "confirm_one") {
    if (await isQuestionOrOther(text)) {
      const ts = JSON.parse((session.pendingTimesheetDesc as string) ?? "{}") as PendingTimesheet;
      await sendMessage(
        `No problem — here are the hours again:\n\n` +
        `Caregiver: ${ts.caregiverName}  |  Date: ${ts.date}  |  Hours: ${ts.hours}  |  Amount: ${ts.amountOwed}\n\n` +
        `Reply APPROVE to release payment or DISPUTE if something looks off.`
      );
      return;
    }

    const decision = await parseWithClaude(
      '"approve", "yes", "looks good", "go ahead", "ok", "correct", "confirm", "pay them" → APPROVE. ' +
      '"dispute", "no", "wrong", "incorrect", "that\'s off", "disagree", "flag", "reject" → DISPUTE. ' +
      'Reply with exactly APPROVE or DISPUTE.',
      text,
      10
    );

    const tsId   = session.pendingTimesheetId as string;
    const tsData = JSON.parse((session.pendingTimesheetDesc as string) ?? "{}") as PendingTimesheet;

    if (decision === "APPROVE") {
      await db.collection("shiftHours").doc(tsId).update({
        status:     "approved",
        approvedAt: new Date().toISOString(),
        approvedBy: clientId,
      });

      // Fire payment processing (fire-and-forget)
      if (tsData.appointmentId && tsData.caregiverId && tsData.amountCents > 0) {
        import("../billing/visitBilling").then(({ createVisitPayment }) => {
          createVisitPayment({
            appointmentId:  tsData.appointmentId,
            clientId,
            clientPhone:    "",
            caregiverId:    tsData.caregiverId,
            caregiverName:  tsData.caregiverName,
            caregiverPhone: "",
            durationHours:  tsData.hours,
            hourlyRate:     tsData.amountCents / 100 / Math.max(tsData.hours, 1),
            date:           tsData.date,
          });
        }).catch(() => {});
      }

      const approveMsg = await generateCaraMessage({
        audience:  "family",
        context:   `Family just approved ${tsData.caregiverName}'s timesheet for ${tsData.date} (${tsData.hours} hrs, ${tsData.amountOwed}). Write a brief warm confirmation and let them know payment will process tonight.`,
        fallback:   `Approved! ${tsData.caregiverName}'s payment of ${tsData.amountOwed} will process tonight.`,
        maxTokens: 80,
      });
      await sendMessage(approveMsg);
    } else {
      await db.collection("shiftHours").doc(tsId).update({
        status:     "disputed",
        disputedAt: new Date().toISOString(),
        disputedBy: clientId,
      });

      await db.collection("dispute_flags").add({
        type:          "timesheet_dispute",
        clientId,
        timesheetId:   tsId,
        caregiverId:   tsData.caregiverId,
        caregiverName: tsData.caregiverName,
        date:          tsData.date,
        amountCents:   tsData.amountCents,
        flaggedAt:     new Date().toISOString(),
        status:        "open",
      }).catch(() => {});

      const disputeMsg = await generateCaraMessage({
        audience:  "family",
        context:   `Family flagged a dispute on ${tsData.caregiverName}'s timesheet for ${tsData.date}. Acknowledge the dispute warmly and let them know a coordinator will follow up within 24 hours.`,
        fallback:   `Got it — I've flagged ${tsData.caregiverName}'s timesheet for review. A coordinator will follow up within 24 hours.`,
        maxTokens: 80,
      });
      await sendMessage(disputeMsg);
    }

    // Check if there are more timesheets in the queue
    const queue = (session.pendingTimesheetQueue as string[]) ?? [];
    await db.collection("agent_sessions").doc(phone).update({
      timesheetStep:         admin.firestore.FieldValue.delete(),
      pendingTimesheetId:    admin.firestore.FieldValue.delete(),
      pendingTimesheetDesc:  admin.firestore.FieldValue.delete(),
      pendingTimesheetQueue: admin.firestore.FieldValue.delete(),
    }).catch(() => {});

    if (queue.length > 0) {
      const nextSnap = await db.collection("shiftHours").doc(queue[0]).get().catch(() => null);
      if (nextSnap?.exists) {
        const nextTs = nextSnap.data()!;
        const cgSnap = await db.collection("caregivers").doc(nextTs.caregiverId as string).get().catch(() => null);
        const cg = cgSnap?.data() ?? {};
        const next: PendingTimesheet = {
          id:            nextSnap.id,
          caregiverName: (cg.name ?? `${cg.firstName ?? ""} ${cg.lastName ?? ""}`.trim()) || "Caregiver",
          date:          nextTs.date as string,
          clockIn:       nextTs.clockInTime as string ?? "",
          clockOut:      nextTs.clockOutTime as string ?? "",
          hours:         Number(nextTs.durationHours ?? 0),
          amountOwed:    `$${((nextTs.amountCents as number ?? 0) / 100).toFixed(2)}`,
          amountCents:   nextTs.amountCents as number ?? 0,
          caregiverId:   nextTs.caregiverId as string,
          appointmentId: nextTs.appointmentId as string ?? "",
        };

        await db.collection("agent_sessions").doc(phone).update({
          timesheetStep:         "confirm_one",
          pendingTimesheetId:    next.id,
          pendingTimesheetDesc:  JSON.stringify(next),
          pendingTimesheetQueue: queue.slice(1),
          pendingTimesheetSetAt: new Date().toISOString(),
        });

        const timeRange2 = next.clockIn && next.clockOut ? ` (${next.clockIn} – ${next.clockOut})` : "";
        await sendMessage(
          `You have one more to review:\n\n` +
          `Caregiver: ${next.caregiverName}\n` +
          `Date: ${next.date}${timeRange2}\n` +
          `Hours worked: ${next.hours}\n` +
          `Amount: ${next.amountOwed}\n\n` +
          `Reply APPROVE or DISPUTE.`
        );
      }
    }
    return;
  }
}
