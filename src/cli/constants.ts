export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--export actor] [--import path=export.json|-] [--strip-metadata] [--in state.json|-] [--out file.json] [--server stdio|http|websocket] [--stateless] [--session id] [--history n] [--format cbor|json] [--port n] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "hash", "version", "events", "data" } when all :param values are
satisfied (version counts runs since the first, bumped by each --in; events
is the stream of every --param/--set/--invoke/--import given so far, in order,
each as { version, type: "parameter" | "override" | "invoke" | "import", path,
value }, with the
engine's writes woven in as { version, type: "set" | "add" | "subtract",
path, value, rolled, source, line, column } and every roll as
{ version, type: "roll", path, dice: "XdY", value: [faces] } — in the order
made, an invoke's right after it; hash is a sha256 over the compact JSON of
the rest, plus "result" under --invoke), or
{ "hash", "version", "events", "query": […] } listing the outstanding
parameters. A resolved sheet must also pass its !validate rules; failing
rules print as { "errors": […] }.

Arguments:
  entry.yaml    Entry document (default: main from .goblin.yaml).
                If it contains a directory, $tmpl('…') resolves relative to it.
  --compact     Single-line JSON output (default: pretty-printed).
  --param       Provide a :param value (repeatable). Values parse as JSON,
                falling back to strings: --param level=3 --param name=Aria
  --set         Override any value by path (repeatable, applied after
                patches): --set level=5. Overridden originals are ignored,
                even missing paths; :param records keep their :type contract.
  --invoke      Call a function on the resolved document (once per run), by
                path with JSON arguments: --invoke rest.short or
                --invoke 'heal(5)'. Its writes land in "data" and its return
                value prints as "result"; the call is saved as an event, so
                --in replays its writes (a later --set still wins). It needs a
                stable state: no --param or --set in the same run, and an
                --in state (or, without one, the entry) that resolves to
                "data". An invoke that brings in new params answers
                { "query" }; save it and answer with --param.
  --export      Print one actor's state instead of the envelope, by namespace
                (--export aria) or tree path (--export party.scout):
                { "hash", "application", "actor", "events" }, where events
                holds one { type: "set", path, value } per node the files
                cannot make again on their own (params, --set values,
                imports, an invoke's writes, rolls), with its current value
                and its path relative to the actor; application is a sha256
                over every goblin file loaded. It exports the --in state (or
                the entry), which must resolve to "data"; it takes no
                --param, --set, --invoke or --import.
  --import      Import an --export output (a file, or - for stdin) into the
                actor at path, a namespace or tree path that may differ from
                the one it was exported from: --import aria=aria.json. It is
                saved as one { type: "import", path, value: { application,
                events } } event of the next version; on replay each set
                fills a :param node there, or else overrides it like --set,
                and later inputs still win. It fails unless application
                matches this entry's files and path holds an actor. It
                cannot be combined with --param, --set or --invoke.
  --strip-metadata  Drop metadata keys (:doc, :type, !validate, …) from the
                printed data, leaving plain values only. Functions print as
                their source expression; records left empty collapse to null.
  --in          Rehydrate from a prior { "data": … } or { "query": … }
                output (a file, or - for stdin): all its events replay. Inputs apply in order
                (later wins) and make the writes again; every recorded roll
                lands as it did, and an invoke's writes keep their values. This
                run's --param/--set/--invoke are appended as events of the
                incremented version. A hash must match the rest of the state.
  --out         Also write the JSON to this file (replacing it) when the
                document resolves to { "data": … } or asks with
                { "query": … }; an { "errors" } result leaves it untouched.
  --server      Stay up as a JSON-RPC 2.0 server instead of resolving once.
                stdio reads requests from stdin and writes responses to
                stdout, each message one --format item; it exits at end of
                stdin. http answers requests (or batches) POSTed to / on
                127.0.0.1 — 200 with the response, 204 when all were
                notifications — until killed, logging its URL to stderr.
                websocket accepts upgrades at / on 127.0.0.1 (refusing
                browser pages from other origins) and answers each message
                frame with one, in order per connection, until killed,
                logging its ws:// URL to stderr.
                Method "resolve" takes { entry?, in?, inputs?, stripMetadata? }
                — in is a prior envelope (--stateless only), inputs a list
                of { type: "parameter" | "override" | "invoke", path, value }
                — and answers the envelope a run would print, plus
                "previous" and "sessionID" unless --stateless.
                Method "export" takes { entry?, in?, actor } and answers what
                --export prints; "import" takes { entry?, in?, path, export }
                and answers like "resolve" (a session's head stands in for in).
                Cannot be combined with --param, --set, --invoke, --export,
                --import, --out, --strip-metadata or --compact.
  --stateless   Answer each --server call on its own (needs --server). By
                default a server is a session: it gets a UUID ("sessionID"
                in every answer) and appends each turn a call answers (bar
                { "errors" }) to ~/.goblin/sessions/<sessionID>/log.cbor, a
                CBOR Sequence: a checkpoint holding every event so far, then
                one { version, entry, events, hash } item per turn with only
                its new events. manifest.json holds { "entry", "version",
                "offsets" }, each version's byte offset in the log. A call
                continues from the head if it names the same entry, else
                starts a fresh log; "previous" is the version it continued
                from, or null. A session keeps its own history, so it
                refuses --in and a "resolve" with "in". Method "rewind"
                takes { version } and cuts the log back to it, so the next
                call continues from there.
  --session     Continue a prior --server session by its sessionID: its
                log is reopened, a half-written last turn cut off, and the
                next call continues from its head. Fails if no such session
                was saved. Cannot be combined with --stateless.
  --history     How many versions, the latest among them, a --server
                session can rewind to (an integer >= 1, default 30); older
                ones fold into a new checkpoint. Cannot be combined with
                --stateless.
  --format      Wire format for --server requests and responses: cbor
                (default; one CBOR item per message, application/cbor over
                http, binary frames over websocket) or json (one line per
                message over stdio, application/json over http, text frames
                over websocket). A frame of the other kind closes the
                socket (1003).
  --port        Port for --server http or websocket (default 8080; 0 picks
                a free one).
  --help, -h    Show this help.`;

/** `--server http|websocket` listens here unless `--port` says otherwise. */
export const DEFAULT_PORT = 8080;

export const INVOKE_ALONE =
  '--invoke cannot be combined with --param or --set: invoke on a stable state, answer in another run';

export const IMPORT_ALONE = '--import cannot be combined with --param, --set or --invoke: import in a run of its own';

export const EXPORT_ALONE = '--export takes no inputs: it exports the --in state (or the entry) as it stands';

export const STATEFUL_IN = 'a stateful --server keeps its own history: in (--in) needs --stateless';

/** Flags that shape a single run's inputs or output, meaningless to a server answering many. */
export const ONE_SHOT = new Set([
  '--param',
  '--set',
  '--invoke',
  '--export',
  '--import',
  '--out',
  '--strip-metadata',
  '--compact',
]);
