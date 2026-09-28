// Bun loads the project's .env into every run, tests included, so a
// developer's own vendor key would sign the suite in to that vendor. Tests
// start signed out; one that needs a key sets it itself.
delete process.env.ANTHROPIC_API;
delete process.env.OPENAI_SECRET;
