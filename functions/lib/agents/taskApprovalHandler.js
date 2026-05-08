"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleTaskApproval = handleTaskApproval;
const client_1 = require("../linq/client");
async function handleTaskApproval(taskDoc, choice, session, chatId) {
    var _a, _b, _c;
    const task = taskDoc.data();
    const options = (_a = task.options) !== null && _a !== void 0 ? _a : [];
    const idx = parseInt(choice, 10) - 1;
    if (idx < 0 || idx >= options.length) {
        await (0, client_1.sendMessage)(chatId, "Please reply 1, 2, or 3 to choose a caregiver.");
        return;
    }
    const selected = options[idx];
    // Mark task as awaiting final web confirmation
    await taskDoc.ref.update({ status: "pending_confirm", selectedIdx: idx });
    const appUrl = (_b = process.env.APP_URL) !== null && _b !== void 0 ? _b : "https://app.careconnecxx.com";
    const confirmUrl = `${appUrl}/confirm/${task.confirmToken}`;
    await (0, client_1.sendMessage)(chatId, {
        parts: [
            {
                type: "text",
                value: `Great choice! Tap below to confirm ${selected.name} for your ${(_c = task.time) !== null && _c !== void 0 ? _c : "upcoming"} visit.\n` +
                    `Nothing is booked until you tap Confirm.`,
            },
            { type: "link", value: confirmUrl },
        ],
    });
}
//# sourceMappingURL=taskApprovalHandler.js.map