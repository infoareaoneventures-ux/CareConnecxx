import * as admin from "firebase-admin";
import { sendMessage, AgentSession } from "../linq/client";

export async function handleTaskApproval(
  taskDoc: admin.firestore.QueryDocumentSnapshot,
  choice: string,
  session: AgentSession,
  chatId: string
): Promise<void> {
  const task    = taskDoc.data();
  const options = task.options ?? [];
  const idx     = parseInt(choice, 10) - 1;

  if (idx < 0 || idx >= options.length) {
    await sendMessage(chatId, "Please reply 1, 2, or 3 to choose a caregiver.");
    return;
  }

  const selected = options[idx];

  // Mark task as awaiting final web confirmation
  await taskDoc.ref.update({ status: "pending_confirm", selectedIdx: idx });

  const appUrl = process.env.APP_URL ?? "https://cara.app";
  const confirmUrl = `${appUrl}/confirm/${task.confirmToken}`;

  await sendMessage(chatId, {
    parts: [
      {
        type:  "text",
        value:
          `Great choice! Tap below to confirm ${selected.name} for your ${task.time ?? "upcoming"} visit.\n` +
          `Nothing is booked until you tap Confirm.`,
      },
      { type: "link", value: confirmUrl },
    ],
  });
}
