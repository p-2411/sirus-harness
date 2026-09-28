# Graph Report - /Users/parhamsepasgozar/Documents/GitHub/sirus-harness  (2026-09-28)

## Corpus Check
- 216 files · ~206,180 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2161 nodes · 6047 edges · 107 communities (101 shown, 6 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 120 edges (avg confidence: 0.79)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Filesystem Checkpoints
- Transcript Activity Rendering
- Terminal Selection and Notifications
- Agent Tool Server
- Session Types and Roster
- Session Facade Lifecycle
- Agent Runtime Lifecycle
- Slash Command Registry
- Harness Launch and Skills
- Session Snapshot Serialization
- Conversation Timeline
- Subagent Execution and Cancellation
- Participant Routing and Turns
- Subscription Login and RPC
- Settings Persistence
- System Simplification Proposals
- Subscription Usage Limits
- Markdown Rendering
- Worker Commands
- Runtime Dependencies
- Model Catalog and Selection
- Draft Editing and Attachments
- Application Session Persistence
- Checkpoint Rewind Commands
- File Suggestions
- Prompt Controls and Questions
- Graphify Build Pipeline
- Installation Statistics Backend
- Documented Session Architecture
- Terminal Selection and Notifications
- Sirus Product Capabilities
- Sidebar and Session Navigation
- Queued Input Types
- Chat View and Turn Status
- Session Management Commands
- Atomic Storage and Telemetry
- Rewind Snapshot Types
- Provider Credential Sources
- Package Update Lifecycle
- Package Metadata
- ACP Events and Images
- Subagent Execution and Cancellation
- Tool Permission Decisions
- Authentication Commands
- Prompt Controls and Questions
- Runtime Discovery and Naming
- Local Memory Embeddings
- Memory Tool Access
- Permission Modes
- Structured User Questions
- Chat View and Turn Status
- ACP Events and Images
- Scripted Runtime Testing
- File Mention Resolution
- Installation Statistics Design
- Sidebar and Session Navigation
- Participant Mentions
- Agent Tool Server
- Approval Prompt Rendering
- Runtime Discovery and Naming
- Command Dispatch Testing
- CLI Entry Points
- Graph Query Navigation
- Semantic Extraction and Transcription
- Agent Tool Server
- Draft Editing and Attachments
- SQLite Memory Operations
- Historical Worker Routing Designs
- Memory Schema Migration
- Memory Vector Index
- Development Dependencies
- ACP Migration Proposal
- Conversation Timeline
- Queued Message Delivery
- Context Usage Display
- TypeScript Compiler Options
- Pointer Interaction and Selection
- Claude Subscription Usage
- Subscription Login and RPC
- Worker Activity Display
- Draft Editing and Attachments
- Markdown Rendering
- Package Scripts
- TypeScript Source Inclusion
- Scripted Runtime Testing
- Bun Launcher
- Native Session Recovery
- Subagent Execution and Cancellation
- Command Suggestions
- Completed Feature Checklist
- Package Discovery Keywords
- Graph Database Exports
- Command Architecture Documentation
- Wave C Parity Audit
- Harness Dependency Updates
- ACP Events and Images
- Memory Store Interface
- Worker Action Menu
- Conversation Timeline
- Statistics Dashboard
- Repository Graph Merging
- Atomic Storage and Telemetry
- First Session Workflow
- Dependency Overrides
- Package Metadata
- TypeSafe Skill Installation
- Installation Database Schema

## God Nodes (most connected - your core abstractions)
1. `Session` - 123 edges
2. `SessionAgent` - 77 edges
3. `Message` - 51 edges
4. `dataDirectory()` - 39 edges
5. `SubagentRun` - 37 edges
6. `InputBar()` - 36 edges
7. `CommandSession` - 35 edges
8. `Sirus architecture` - 32 edges
9. `PermissionMode` - 30 edges
10. `ParticipantRoster` - 28 edges

## Surprising Connections (you probably didn't know these)
- `Work memory reflections` --semantically_similar_to--> `Persistent memory`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/query.md → README.md
- `Failed semantic chunk retry` --semantically_similar_to--> `Subagent completion reports`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/update.md → README.md
- `Per-subfolder CLI extraction` --semantically_similar_to--> `Subagent Git worktrees`  [INFERRED] [semantically similar]
  .claude/skills/graphify/references/github-and-merge.md → README.md
- `Project graph-first guidance` --conceptually_related_to--> `Repository instruction discovery`  [AMBIGUOUS]
  CLAUDE.md → README.md
- `Session-scoped model, cancellation and subagent state` --conceptually_related_to--> `Session-owned background workers`  [INFERRED]
  todo.md → docs/ARCHITECTURE.md

## Import Cycles
- 2-file cycle: `src/agent_runtime/tools/subagents/index.ts -> src/agent_runtime/tools/subagents/run.ts -> src/agent_runtime/tools/subagents/index.ts`
- 3-file cycle: `src/agent_runtime/memory-access.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/memory-access.ts`
- 3-file cycle: `src/agent_runtime/tools/subagents/index.ts -> src/agent_runtime/tools/subagents/run.ts -> src/agent_runtime/tools/subagents/report.ts -> src/agent_runtime/tools/subagents/index.ts`
- 3-file cycle: `src/memory/schema.ts -> src/memory/store.ts -> src/memory/vectorIndex.ts -> src/memory/schema.ts`
- 4-file cycle: `src/agent_runtime/memory-access.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/prompt.ts -> src/agent_runtime/memory-access.ts`
- 4-file cycle: `src/agent_runtime/memory-access.ts -> src/persistence/index.ts -> src/persistence/sessions.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/memory-access.ts`
- 4-file cycle: `src/agent_runtime/agent.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/agent.ts`
- 4-file cycle: `src/agent_runtime/providers/index.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/providers/index.ts`
- 5-file cycle: `src/agent_runtime/memory-access.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/tools/server.ts -> src/agent_runtime/tools/index.ts -> src/agent_runtime/memory-access.ts`
- 5-file cycle: `src/agent_runtime/memory-access.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/tools/subagents/run.ts -> src/agent_runtime/prompt.ts -> src/agent_runtime/memory-access.ts`
- 5-file cycle: `src/agent_runtime/memory-access.ts -> src/persistence/index.ts -> src/persistence/sessions.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/prompt.ts -> src/agent_runtime/memory-access.ts`
- 5-file cycle: `src/agent_runtime/agent.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/session/turnRunner.ts -> src/agent_runtime/agent.ts`
- 5-file cycle: `src/agent_runtime/agent.ts -> src/agent_runtime/providers/index.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/agent.ts`
- 5-file cycle: `src/agent_runtime/agent.ts -> src/agent_runtime/providers/profiles.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/agent.ts`
- 5-file cycle: `src/agent_runtime/providers/discovery.ts -> src/agent_runtime/providers/index.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/providers/discovery.ts`
- 5-file cycle: `src/agent_runtime/providers/discovery.ts -> src/agent_runtime/providers/profiles.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/providers/discovery.ts`
- 5-file cycle: `src/agent_runtime/providers/index.ts -> src/agent_runtime/providers/provider.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/providers/index.ts`
- 5-file cycle: `src/agent_runtime/providers/index.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/session/naming.ts -> src/agent_runtime/providers/index.ts`
- 5-file cycle: `src/agent_runtime/providers/profiles.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/session/naming.ts -> src/agent_runtime/providers/profiles.ts`
- 5-file cycle: `src/agent_runtime/agent.ts -> src/agent_runtime/providers/sources.ts -> src/persistence/index.ts -> src/agent_runtime/session/index.ts -> src/agent_runtime/session/roster.ts -> src/agent_runtime/agent.ts`

## Hyperedges (group relationships)
- **Hybrid extraction and provenance pipeline** — _claude_skills_graphify_skill_structural_ast_extraction, _claude_skills_graphify_skill_semantic_extraction, _claude_skills_graphify_skill_prompt_versioned_semantic_cache, _claude_skills_graphify_skill_ast_and_semantic_merge, _claude_skills_graphify_references_extraction_spec_semantic_extraction_specification, _claude_skills_graphify_skill_output_gated_semantic_manifest [EXTRACTED 1.00]
- **Subagent-aware checkpoint restoration** — readme_autonomous_subagents, readme_subagent_git_worktrees, readme_automatic_checkpoints, readme_persistent_sessions [EXTRACTED 1.00]
- **Privacy-conscious installation statistics flow** — cloudflare_readme_random_installation_identifier, cloudflare_readme_post_heartbeat, cloudflare_readme_hmac_sha_256_installation_digest, cloudflare_readme_installation_hash_secret, cloudflare_readme_cloudflare_d1, cloudflare_readme_get_stats_rolling_counts, cloudflare_readme_dependency_free_statistics_dashboard, cloudflare_readme_35_day_retention_cleanup [EXTRACTED 1.00]
- **Addressed multi-participant round and timeline flow** — docs_architecture_participantroster, docs_architecture_turnrunner, docs_architecture_transcript, docs_architecture_timeline, docs_architecture_sessionagent [EXTRACTED 1.00]
- **Native recovery safety and fallback contract** — docs_native_session_resume_native_reference, docs_native_session_resume_resume, docs_native_session_resume_credential_affinity, docs_native_session_resume_invalidation [EXTRACTED 1.00]
- **Historical background-worker lifecycle proposal** — docs_superpowers_specs_2026_09_21_workers_design_background_reports, docs_superpowers_specs_2026_09_21_workers_design_isolation, docs_superpowers_specs_2026_09_21_workers_design_fork_steer, docs_superpowers_specs_2026_09_21_workers_design_record, docs_superpowers_specs_2026_09_21_workers_design_strip [EXTRACTED 1.00]

## Communities (107 total, 6 thin omitted)

### Community 0 - "Filesystem Checkpoints"
Cohesion: 0.07
Nodes (34): CheckpointLog, DirectoryActivity, keyFor(), ProcessDirectoryActivity, activeSubagentCount(), AgentFileChange, captureCheckpoint(), checkpointFailure() (+26 more)

### Community 1 - "Transcript Activity Rendering"
Cohesion: 0.05
Nodes (55): INTERRUPTED_REASON, CompactionBlock, ToolCallDiff, ToolCallStatus, formatElapsed(), turnPhase(), TurnStatus(), turnThought() (+47 more)

### Community 2 - "Terminal Selection and Notifications"
Cohesion: 0.07
Nodes (58): ElementRef, hit(), hitArea(), isPressingTarget(), moveAt(), pressAt(), releaseAt(), Target (+50 more)

### Community 3 - "Agent Tool Server"
Cohesion: 0.06
Nodes (44): isMemoryAccessEnabled(), setMemoryAccessEnabled(), identity(), sirusPrompt(), toolsLine(), invalidateAllRuntimes(), agentTools, booleanArg() (+36 more)

### Community 4 - "Session Types and Roster"
Cohesion: 0.06
Nodes (19): RuntimeHost, RosterOptions, TurnRunnerOptions, sirusMcpServerEntry(), findSubagent(), findSubagentByCall(), listeners, notifySubagentProgress() (+11 more)

### Community 5 - "Session Facade Lifecycle"
Cohesion: 0.06
Nodes (5): resolveSessionOptions(), Session, registerToolSession(), NoticeBlock, Pane()

### Community 6 - "Agent Runtime Lifecycle"
Cohesion: 0.10
Nodes (8): SessionAgent, sourceProfileHome(), Source, Runtime, runtimeGeneration(), RuntimeUpdate, readOnlyTools(), NativeSession

### Community 7 - "Slash Command Registry"
Cohesion: 0.08
Nodes (34): loginCommandSpec, logoutCommandSpec, doctorCommandSpec, helpCommand(), helpText(), imageCommandSpec, notifyCommand(), notifyCommandSpec (+26 more)

### Community 8 - "Harness Launch and Skills"
Cohesion: 0.10
Nodes (42): adapterScript(), agentsPointer(), CLAUDE_SKILLS_OFF, CLAUDE_TOOLS_OFF, claudeLaunch(), CODEX_MODES, CODEX_TARGET_TRIPLES, codexBinaryPath() (+34 more)

### Community 9 - "Session Snapshot Serialization"
Cohesion: 0.06
Nodes (41): DEFAULT_THINKING_LEVEL, failOpenToolCalls(), IMAGE_MEDIA_TYPES, PLAN_MARKS, TextBlock, ThoughtBlock, TOOL_CALL_STATUSES, TOOL_KINDS (+33 more)

### Community 10 - "Conversation Timeline"
Cohesion: 0.08
Nodes (6): RespondOptions, ChangeFeed, Timeline, mergeTimeline(), Transcript, Message

### Community 11 - "Subagent Execution and Cancellation"
Cohesion: 0.12
Nodes (31): touchSubagent(), describeRun(), describeSubagents(), displayPath(), elapsedSeconds(), failedCalls(), finalMessageOf(), renderTranscript() (+23 more)

### Community 12 - "Participant Routing and Turns"
Cohesion: 0.11
Nodes (13): servableModelIds(), servesModel(), bareName(), keyOf(), MentionMatch, mentionPattern, NAME_PATTERN, ParticipantRoster (+5 more)

### Community 13 - "Subscription Login and RPC"
Cohesion: 0.12
Nodes (26): VendorInfo, ClaudeAuthStatus, claudeBinaryPath(), claudePlan(), claudeStatus(), describeClaude(), describeGpt(), gptPlan() (+18 more)

### Community 14 - "Settings Persistence"
Cohesion: 0.11
Nodes (29): loadApiKeys(), loadMemoryAccessPreference(), loadNotificationPreference(), loadSirusModelPreference(), loadSubscriptionPreferences(), PersistedSessions, saveApiKeys(), saveMemoryAccessPreference() (+21 more)

### Community 15 - "System Simplification Proposals"
Cohesion: 0.11
Nodes (32): Planned facade decomposition, Simplify system design implementation plan, Refactor dependency ordering, Planned characterization and compatibility checks, Frontend runtime-consumer audit (2026-09-07), Message-count send acceptance, Persistence, memory, commands and miscellaneous audit (2026-09-07), Command secret string-reentry defect (+24 more)

### Community 16 - "Subscription Usage Limits"
Cohesion: 0.15
Nodes (26): readClaudeSubscriptionUsage(), onProviderChange, readCodexRateLimits(), allowanceWindow(), cachedSubscriptionRemaining(), claudeSubscriptionUsage(), codexSubscriptionUsage(), duration() (+18 more)

### Community 17 - "Markdown Rendering"
Cohesion: 0.12
Nodes (23): NAME_PATTERN_SOURCE, BlockContext, BlockRenderer, blockRenderers, renderListItemBlock(), renderTable(), textBlock, InlineContext (+15 more)

### Community 18 - "Worker Commands"
Cohesion: 0.14
Nodes (25): workerName(), workerTitle(), THINKING_LEVEL_DESCRIPTIONS, agentsCommand(), agentsMenuItems(), compareModelVersions(), describeWorkers(), findWorker() (+17 more)

### Community 19 - "Runtime Dependencies"
Cohesion: 0.07
Nodes (29): @agentclientprotocol/claude-agent-acp, @agentclientprotocol/codex-acp, @agentclientprotocol/sdk, @anthropic-ai/claude-agent-sdk, bun, @huggingface/transformers, ink, marked (+21 more)

### Community 20 - "Model Catalog and Selection"
Cohesion: 0.15
Nodes (24): BY_ID, isKnownModel(), isListedModel(), listedDescription(), listedModels(), listedVendorOf(), modelIds(), modelInfo (+16 more)

### Community 21 - "Draft Editing and Attachments"
Cohesion: 0.14
Nodes (25): KEY_BINDINGS, invocableNativeCommands(), isNativeCommand(), composeContent(), createInputHistory(), draftCursorRow(), draftRows(), moveDraftRow() (+17 more)

### Community 22 - "Application Session Persistence"
Cohesion: 0.16
Nodes (22): DEFAULT_MODEL, App(), createDraft(), createWorkspace(), nextSessionName(), startSession(), Workspace, deleteSessionSnapshot() (+14 more)

### Community 23 - "Checkpoint Rewind Commands"
Cohesion: 0.15
Nodes (22): defaultDirectoryActivity, checkpointsEnabled(), checkpointNumber(), describeRewind(), formatCheckpointAge(), listFiles(), noCheckpoints(), parseRewindScope() (+14 more)

### Community 24 - "File Suggestions"
Cohesion: 0.15
Nodes (22): activeFileMention(), directoryRank(), excludedDirectories, FileMention, fileRank(), fileSearchDirectory(), ignoredNames(), listDirectoryEntries() (+14 more)

### Community 25 - "Prompt Controls and Questions"
Cohesion: 0.13
Nodes (14): Feedback, FeedbackKind, CommandMenuEntry, onFirstLine(), onLastLine(), EntryInput(), FEEDBACK_ICONS, InputFeedback() (+6 more)

### Community 26 - "Graphify Build Pipeline"
Cohesion: 0.16
Nodes (26): Graphify invocation guidance, Folder watcher, Raw URL corpus, Three-second debounce, URL corpus ingestion, URL ingestion and watch reference, Commit hook and CLAUDE integration reference, Post-commit graph rebuild (+18 more)

### Community 27 - "Installation Statistics Backend"
Cohesion: 0.14
Nodes (18): corsHeaders(), D1Database, D1Statement, emptyResponse(), Env, fetch(), handle(), handleHeartbeat() (+10 more)

### Community 28 - "Documented Session Architecture"
Cohesion: 0.18
Nodes (26): Sirus architecture, Model and vendor catalog, CheckpointLog and DirectoryActivity, Runtime-owned compaction, Sirus delegation tools, Vendor launch specifications, Sirus loopback MCP server, Persistent SQLite vector memory (+18 more)

### Community 29 - "Terminal Selection and Notifications"
Cohesion: 0.17
Nodes (19): useTerminalFocus(), copyToClipboard(), nativeCopy(), osc52(), DEFAULT_NOTIFICATION_MODE, nativeNotify(), notify(), plain() (+11 more)

### Community 30 - "Sirus Product Capabilities"
Cohesion: 0.16
Nodes (21): HIDDEN, isNativeCommand(), listsFile(), nativeCommandFrom(), nativeCommands(), nativePrompt(), rememberNativeCommands(), stored() (+13 more)

### Community 31 - "Sidebar and Session Navigation"
Cohesion: 0.17
Nodes (11): QuestionRow(), useClickable(), ResumePicker(), ResumeRow(), formatRelativeTime(), matchesSession(), SESSION_STATUS_APPEARANCE, SessionItem() (+3 more)

### Community 32 - "Queued Input Types"
Cohesion: 0.13
Nodes (7): NativeCommand, MessageQueue, QueuedMessage, ImageBlock, MessageBlock, InputBarProps, SentDraft

### Community 33 - "Chat View and Turn Status"
Cohesion: 0.13
Nodes (17): SessionStatus, commandRegistry, HORSE, HORSE_WIDTH, ChatHeader(), PlanChecklist(), InputMode, Spinner() (+9 more)

### Community 34 - "Session Management Commands"
Cohesion: 0.11
Nodes (6): changeModel(), modelRestartWarning(), compactCommand(), renameSession(), CommandContext, CommandSession

### Community 35 - "Atomic Storage and Telemetry"
Cohesion: 0.17
Nodes (22): Automatic checkpoints, Autonomous subagents, Bundled Bun runtime, Claude Code, Claude Code plugins, Codex, Global memory, Local Sirus data directory (+14 more)

### Community 36 - "Rewind Snapshot Types"
Cohesion: 0.17
Nodes (11): Participant, RewindOptions, RewindPreview, RewindResult, ResolvedSessionOptions, SessionOptions, SessionSnapshot, SessionTiming (+3 more)

### Community 37 - "Provider Credential Sources"
Cohesion: 0.13
Nodes (19): codexBinaryPath(), createProvider(), ApiSource, createSourceStore(), listeners, notifyProviderSourceChange(), onProviderSourceChange(), SubscriptionSource (+11 more)

### Community 38 - "Package Update Lifecycle"
Cohesion: 0.15
Nodes (18): updateCommand(), updateCommandSpec, versionCommandSpec, appendLimited(), checkSirusUpdate(), CommandResult, isNewerVersion(), isSourceCheckout() (+10 more)

### Community 39 - "Package Metadata"
Cohesion: 0.10
Nodes (20): author, bin, sirus, bugs, url, description, engines, bun (+12 more)

### Community 40 - "ACP Events and Images"
Cohesion: 0.11
Nodes (15): CANCELLED, CANCELLED_ELICITATION, CLIENT_CAPABILITIES, CompactionStatus, DECLINED, detailOf(), EFFORT_OPTION_IDS, listedModelsIn() (+7 more)

### Community 41 - "Subagent Execution and Cancellation"
Cohesion: 0.21
Nodes (14): abortable(), abortReason(), isAbortError(), throwIfAborted(), TurnCancelledError, isDirectory(), maskSecrets(), TurnInput (+6 more)

### Community 42 - "Tool Permission Decisions"
Cohesion: 0.13
Nodes (18): ApprovalRequest, CANCELLED, chosenOption(), decisions, getPermissionsVersion(), isAwaitingApproval(), lastDecision(), listeners (+10 more)

### Community 43 - "Authentication Commands"
Cohesion: 0.24
Nodes (15): parseVendor(), Vendor, providerFor(), maskApiKey(), SubscriptionUsage, describeSource(), describeSubscriptionUsage(), describeVendor() (+7 more)

### Community 44 - "Prompt Controls and Questions"
Cohesion: 0.15
Nodes (17): QuestionAnswer, QuestionField, QuestionRequest, InputEdit, inputEditForKey(), InputState, isKeyboardProtocolReport(), PromptBar() (+9 more)

### Community 45 - "Runtime Discovery and Naming"
Cohesion: 0.23
Nodes (14): listedFile(), profiledModelsOf(), rememberListedModels(), attempted, discoverMissingModels(), allProviders(), sourceEnvironment(), subscriptionEnvironment() (+6 more)

### Community 46 - "Local Memory Embeddings"
Cohesion: 0.13
Nodes (12): EmbeddingProvider, FeatureExtractor, loadExtractor(), LOCAL_EMBEDDING_DIMENSIONS, LOCAL_EMBEDDING_MODEL, LOCAL_EMBEDDING_MODEL_ID, LocalEmbeddingProvider, MemoryLink (+4 more)

### Community 47 - "Memory Tool Access"
Cohesion: 0.15
Nodes (17): SELECT_MEMORIES, configureSQLite(), loadVectorExtension(), Memory, memoryEmbeddingText(), MemoryInput, MemorySearchResult, memoryStoreFor() (+9 more)

### Community 48 - "Permission Modes"
Cohesion: 0.16
Nodes (12): ASK_MODE_DESCRIPTION, DEFAULT_PERMISSION_MODE, nextPermissionMode(), parsePermissionMode(), PERMISSION_MODE_NAMES, PERMISSION_MODES, PermissionMode, Launch (+4 more)

### Community 49 - "Structured User Questions"
Cohesion: 0.18
Nodes (15): CANCEL, DECLINE, getQuestionsVersion(), isRecord(), listeners, notifyListeners(), optionsOf(), otherFieldOf() (+7 more)

### Community 50 - "Chat View and Turn Status"
Cohesion: 0.15
Nodes (8): PromptInput, usageCommandSpec, Chat(), currentPlans(), promptHistory(), renderChat(), projects, bindScriptedRuntime()

### Community 51 - "ACP Events and Images"
Cohesion: 0.23
Nodes (17): ImageMediaType, attachClipboardImage(), attachImageFile(), clipboardImageFile(), detectImageType(), EXTENSIONS, formatBytes(), imageData() (+9 more)

### Community 52 - "Scripted Runtime Testing"
Cohesion: 0.14
Nodes (11): SelectOption, SessionSpec, boundRuntimes, ForkOptions, RuntimeOptions, prompt, writeResponse(), ScriptedBinding (+3 more)

### Community 53 - "File Mention Resolution"
Cohesion: 0.21
Nodes (13): directoryListing(), FileMention, MAX_MENTION_DIRECTORY_ENTRIES, MAX_MENTION_FILE_BYTES, MAX_MENTION_FILES, MAX_MENTION_TOTAL_BYTES, parseFileMentions(), readTextFile() (+5 more)

### Community 54 - "Installation Statistics Design"
Cohesion: 0.21
Nodes (17): Deploy statistics dashboard, GitHub Pages deployment, Statistics dashboard artifact, 35-day retention cleanup, Cloudflare D1, Cloudflare Worker, Dashboard CORS origin, Dependency-free statistics dashboard (+9 more)

### Community 55 - "Sidebar and Session Navigation"
Cohesion: 0.27
Nodes (14): describeRequester(), pendingApprovals(), subscribePermissions(), pendingQuestions(), subscribeQuestions(), listAllSubagents(), questionText(), firstLine() (+6 more)

### Community 56 - "Participant Mentions"
Cohesion: 0.21
Nodes (13): formatFileMention(), MENTION_MENU_VISIBLE_ITEMS, MentionMenu(), MentionMenuItem, mentionMenuItems(), activeMention(), activeMentionPattern, ParticipantMenu() (+5 more)

### Community 57 - "Agent Tool Server"
Cohesion: 0.19
Nodes (10): vendorOf(), promptFor(), TurnRunner, agentDefinitions(), definitionModel(), definitionsIn(), pluginAgents(), projectDirectories() (+2 more)

### Community 58 - "Approval Prompt Rendering"
Cohesion: 0.22
Nodes (12): ApprovalDecision, ApprovalChoice, approvalChoices(), approvalDetail(), ApprovalPrompt(), detailColor(), KIND_KEYS, markLine() (+4 more)

### Community 59 - "Runtime Discovery and Naming"
Cohesion: 0.17
Nodes (14): ListedModel, live, MODE_KINDS, modeKindOf(), PromptResult, toolCallBlockFrom(), toolContent(), toolKind() (+6 more)

### Community 60 - "Command Dispatch Testing"
Cohesion: 0.16
Nodes (7): backgroundTaskFrom(), commandMenu(), executeCommand(), parseCommandLine(), items(), menuItems(), runCommand()

### Community 61 - "CLI Entry Points"
Cohesion: 0.26
Nodes (10): disposeAllRuntimes(), stopSirusMcpServer(), enableCheckpoints(), parseCliArguments(), resolveResumeSelection(), runCli(), runPrint(), USAGE (+2 more)

### Community 62 - "Graph Query Navigation"
Cohesion: 0.26
Nodes (14): Graphify MCP server, Native CLAUDE.md graph integration, Breadth-first traversal, Constrained vocabulary expansion, Depth-first traversal, Graph query reference, Graphify query, NetworkX traversal fallback (+6 more)

### Community 63 - "Semantic Extraction and Transcription"
Cohesion: 0.16
Nodes (14): Absolute source provenance, Concept rationale attributes, Extraction confidence rubric, Full-path deterministic node IDs, Hyperedges, Semantic extraction specification, Audio and video transcription reference, Graph-informed transcription prompt (+6 more)

### Community 64 - "Agent Tool Server"
Cohesion: 0.14
Nodes (8): MODELS, AGENT_TOOLS, MEMORY_TOOLS, stubHost, SubagentHost, SubagentSpawnCall, TestEmbeddingProvider, WorkerContext

### Community 65 - "Draft Editing and Attachments"
Cohesion: 0.26
Nodes (12): imagePlaceholder(), imagePlaceholders(), isImagePlaceholder(), removedPlaceholders(), stripPlaceholders(), useDraftImages(), DraftRow(), DraftText() (+4 more)

### Community 67 - "Historical Worker Routing Designs"
Cohesion: 0.26
Nodes (13): WorkerStrip and SpawnAgent transcript row, Historical latest-model routing candidates, Historical bounded confidence fallback, Removed Jev session-model routing, Historical ModelProfile routing criteria, Jev session routing: historical approved design, Proposed worker completion wakes owner, Proposed owner-context fork and steering (+5 more)

### Community 68 - "Memory Schema Migration"
Cohesion: 0.29
Nodes (12): countAllMemories(), createMemoryIndexes(), createMemoryTable(), createVectorTable(), globalScopeId(), legacyLinks(), LegacyMemoryRow, migrate() (+4 more)

### Community 69 - "Memory Vector Index"
Cohesion: 0.22
Nodes (6): MEMORY_COLUMNS, MemoryRow, SchemaEmbedder, SearchRow, VectorIndex, VectorIndexOptions

### Community 70 - "Development Dependencies"
Cohesion: 0.17
Nodes (12): bun-types, devDependencies, bun-types, tsx, @types/node, @types/react, typescript, types (+4 more)

### Community 71 - "ACP Migration Proposal"
Cohesion: 0.27
Nodes (12): Agent Client Protocol, Vendor permission modes, ACP form elicitation, ACP Runtime, Proposed ACP-only vendor runtime migration, Proposed addressed participant transcripts, Proposed pre-prompt checkpoint, Proposed loopback HTTP MCP bridge (+4 more)

### Community 72 - "Conversation Timeline"
Cohesion: 0.26
Nodes (9): FORKED_WORKER_HANDOVER, blockText(), byteSlice(), compactionCut(), RECAP_MAX_BYTES, transcriptText(), VERBS, isPlanCall() (+1 more)

### Community 73 - "Queued Message Delivery"
Cohesion: 0.24
Nodes (3): isAutoSendable(), stripCreationModels(), withIntroductions()

### Community 74 - "Context Usage Display"
Cohesion: 0.29
Nodes (8): contextPercent(), ContextUsage, formatTokens(), describeSessionUsage(), ContextGauge(), MODE_COLORS, StatusRowProps, SubagentStatusRow()

### Community 75 - "TypeScript Compiler Options"
Cohesion: 0.17
Nodes (11): compilerOptions, composite, declaration, isolatedModules, jsx, module, moduleResolution, resolveJsonModule (+3 more)

### Community 76 - "Pointer Interaction and Selection"
Cohesion: 0.25
Nodes (9): BUTTONS, DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, MouseButton, MouseEvent, MouseWheelEvent, normalizedInput(), parseMouseEvent() (+1 more)

### Community 77 - "Claude Subscription Usage"
Cohesion: 0.29
Nodes (6): ClaudeUsageDependencies, ClaudeUsageQuery, createClaudeSubscriptionUsageReader(), SIRUS_CLIENT_ID, SIRUS_VERSION, usage

### Community 79 - "Worker Activity Display"
Cohesion: 0.29
Nodes (9): getSubagentsVersion(), SubagentStatus, subscribeSubagents(), stripWorkers(), workerActivity(), workerColors, WorkerLine(), WorkerSelection (+1 more)

### Community 80 - "Draft Editing and Attachments"
Cohesion: 0.36
Nodes (9): applyInputEdit(), InputHistory, InputKey, lineMove(), nextCharacter(), normalizeNewlines(), previousCharacter(), wordLeft() (+1 more)

### Community 81 - "Markdown Rendering"
Cohesion: 0.36
Nodes (6): renderBlock(), Markdown(), lexMarkdown(), lexSegment(), segmentMarkdown(), segmentTokens

### Community 82 - "Package Scripts"
Cohesion: 0.22
Nodes (9): scripts, i, prepublishOnly, release, release:check, start, test, typecheck (+1 more)

### Community 83 - "TypeScript Source Inclusion"
Cohesion: 0.22
Nodes (8): cloudflare/**/*.ts, src/**/*.ts, src/**/*.tsx, tests/**/*.ts, tests/**/*.tsx, ./tsconfig.base.json, extends, include

### Community 84 - "Scripted Runtime Testing"
Cohesion: 0.22
Nodes (5): createSession(), storedImages(), editorCommand(), attach(), textTurn()

### Community 85 - "Bun Launcher"
Cohesion: 0.25
Nodes (5): entry, { existsSync, statSync }, path, result, { spawnSync }

### Community 86 - "Native Session Recovery"
Cohesion: 0.39
Nodes (8): FORKED_WORKER_HANDOVER, Credential-home affinity, Native-history invalidation, Persisted native-session reference, Implemented native vendor session recovery, Resume-first recovery and replay suppression, Native recovery verification, Historical cross-vendor runtime leak

### Community 87 - "Subagent Execution and Cancellation"
Cohesion: 0.39
Nodes (5): AgentOptions, AgentDefinition, SubagentSpawnOptions, SpawnOptions, ThinkingLevel

### Community 88 - "Command Suggestions"
Cohesion: 0.39
Nodes (6): matchCommands(), COMMAND_MENU_VISIBLE_ITEMS, CommandMenu(), CommandMenuNavigation, moveCommandMenuSelection(), useCommandMenu()

### Community 89 - "Completed Feature Checklist"
Cohesion: 0.29
Nodes (7): ChangeFeed, Exit-save persistence, UI identity and version contract, Completed-item checklist, Save partial responses when quitting, Session-scoped model, cancellation and subagent state, Skills and heartbeat support

### Community 90 - "Package Discovery Keywords"
Cohesion: 0.29
Nodes (7): keywords, agent, ai, cli, coding-agent, terminal, tui

### Community 91 - "Graph Database Exports"
Cohesion: 0.47
Nodes (6): Agent-crawlable wiki, Exports and benchmark reference, FalkorDB export, Neo4j export, OpenCypher MERGE export, Token-reduction benchmark

### Community 92 - "Command Architecture Documentation"
Cohesion: 0.40
Nodes (6): CommandSpec and CommandSession, Proposed structural CommandContext, CommandSession structural interface, Command file-layout rule, Command architecture and layout, Ordered command registry

### Community 93 - "Wave C Parity Audit"
Cohesion: 0.47
Nodes (6): Wave C parity audit, C3 doctor and update notice: landed, External draft editor, C1 input editor and mentions: landed, Wave C pending dependencies, Directory-scoped prompt history

### Community 94 - "Harness Dependency Updates"
Cohesion: 0.33
Nodes (3): changes, manifest, wanted

### Community 95 - "ACP Events and Images"
Cohesion: 0.40
Nodes (3): SessionState, BackgroundTask, findTask()

### Community 97 - "Worker Action Menu"
Cohesion: 0.40
Nodes (5): Cancel — stop it and keep what it has done, graphify_docs_2 (sub-5b7bae90) · working, Send a message — steer it while it works, Show transcript — what it has said and done so far (selected), Terminal worker menu

### Community 99 - "Statistics Dashboard"
Cohesion: 0.50
Nodes (5): Configurable statistics API base, Active-installation dashboard, loadStats, setCount, setStatus

### Community 100 - "Repository Graph Merging"
Cohesion: 0.83
Nodes (4): Cross-repository graph merge, GitHub clone and cross-repo merge reference, Per-subfolder CLI extraction, Reusable GitHub clones

### Community 101 - "Atomic Storage and Telemetry"
Cohesion: 0.50
Nodes (4): Feedback environment details, First session feedback, First-session outcome, Public feedback redaction

### Community 102 - "First Session Workflow"
Cohesion: 0.67
Nodes (4): Named cross-provider review, Your first useful Sirus session, File-only checkpoint undo, Inspectable useful result

### Community 103 - "Dependency Overrides"
Cohesion: 0.50
Nodes (4): overrides, adm-zip, onnxruntime-node, sharp

### Community 104 - "Package Metadata"
Cohesion: 0.67
Nodes (3): files, bin, src

## Ambiguous Edges - Review These
- `Project graph-first guidance` → `Repository instruction discovery`  [AMBIGUOUS]
  README.md · relation: conceptually_related_to
- `Default session and worker routing` → `Removed Jev session-model routing`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-21-jev-session-routing-design.md · relation: conceptually_related_to

## Knowledge Gaps
- **323 isolated node(s):** `{ spawnSync }`, `{ existsSync, statSync }`, `path`, `entry`, `result` (+318 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Project graph-first guidance` and `Repository instruction discovery`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Default session and worker routing` and `Removed Jev session-model routing`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Session` connect `Session Facade Lifecycle` to `Filesystem Checkpoints`, `Session Types and Roster`, `Conversation Timeline`, `Participant Routing and Turns`, `Settings Persistence`, `Application Session Persistence`, `Checkpoint Rewind Commands`, `Prompt Controls and Questions`, `Terminal Selection and Notifications`, `Sidebar and Session Navigation`, `Queued Input Types`, `Chat View and Turn Status`, `Rewind Snapshot Types`, `Authentication Commands`, `Permission Modes`, `Structured User Questions`, `Chat View and Turn Status`, `ACP Events and Images`, `Scripted Runtime Testing`, `File Mention Resolution`, `Sidebar and Session Navigation`, `Agent Tool Server`, `Command Dispatch Testing`, `CLI Entry Points`, `Queued Message Delivery`, `Context Usage Display`, `Scripted Runtime Testing`, `ACP Events and Images`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `dataDirectory()` connect `Runtime Discovery and Naming` to `Filesystem Checkpoints`, `Provider Credential Sources`, `Agent Runtime Lifecycle`, `Harness Launch and Skills`, `Session Snapshot Serialization`, `Subagent Execution and Cancellation`, `Subscription Login and RPC`, `Local Memory Embeddings`, `Memory Tool Access`, `Subscription Usage Limits`, `Settings Persistence`, `ACP Events and Images`, `Model Catalog and Selection`, `Draft Editing and Attachments`, `Sirus Product Capabilities`?**
  _High betweenness centrality (0.061) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Runtime Dependencies` to `Package Metadata`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `{ spawnSync }`, `{ existsSync, statSync }`, `path` to the rest of the system?**
  _323 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Filesystem Checkpoints` be split into smaller, more focused modules?**
  _Cohesion score 0.06603346901854365 - nodes in this community are weakly interconnected._
## Extraction limitations

Actual semantic token usage was not exposed by the worker tools. Zero token counters are placeholders, not measured usage. The original extraction recorded 424 dangling-endpoint edges and 156 collapsed undirected edges; incremental merging cannot recover those losses. Two configuration files (`launch.json` and `settings.json`) produced no AST nodes. Historical proposals and audits describe their source documents, not necessarily current behavior. See `health.json` for diagnostics.
