// The one sentence a token holder is given when the engine (or our own configuration of it) fails behind a token route.
//
// The engine client's own text ("GRIDFORGE_API_KEY is not set", "connect ECONNREFUSED 10.0.3.7:8080", the engine's error body) is a map of
// our network and settings: it goes to the server log through `redact` (lib/mail.ts), never to the response. The sentence says only what is
// true: the failure has been logged. It does not promise a follow-up, because not every route that uses it has one; the route's own
// `error` text says what happens next where something does.

export const GENERATION_FAILED_DETAIL = "We could not generate this right now. It has been logged.";
