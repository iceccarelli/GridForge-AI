// Server-only: the text of the confirmation the scoping assistant sends to a signed-in, verified visitor after a conversation.
// Kept out of the route so a test can read exactly what is said. The assistant is an AI model and the mail says so; it never names an
// engineer, because no engineer took part in the conversation.

export function agentConfirmationText(next: string): string {
  return (
    `Thank you for describing your site to the Time to Power scoping assistant, an AI. No engineer took part in that conversation, ` +
    `and the figures in it come from an engine run, not from a person's opinion.\n\n` +
    `${next}\n\n` +
    `All information is held in strict confidence. An NDA is available immediately on request.\n\n` +
    `— Time to Power`
  );
}
