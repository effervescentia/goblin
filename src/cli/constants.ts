export const USAGE = `goblin [entry.yaml] [--compact] [--param key=value] [--set path=value] [--invoke fn(args)] [--strip-metadata] [--in state.json|-] [--out file.json] [--server stdio|http|websocket] [--stateless] [--format cbor|json] [--port n] [--help]

Resolves a goblin document and prints the result as JSON: either
{ "hash", "version", "events", "data" } when all :param values are
satisfied (version counts runs since the first, bumped by each --in; events
is the stream of every --param/--set/--invoke given so far, in order, each
as { version, type: "parameter" | "override" | "invoke", path, value }, with the
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
                — in is a prior envelope, inputs a list of { type:
                "parameter" | "override" | "invoke", path, value } — and
                answers the envelope a run would print, plus "previous"
                and "sessionID" unless --stateless.
                Cannot be combined with --param, --set, --invoke, --out,
                --strip-metadata or --compact.
  --stateless   Answer each --server call on its own (needs --server). By
                default a server is a session: it gets a UUID ("sessionID"
                in every answer) and saves each envelope a call answers
                (bar { "errors" }) as ~/.goblin/sessions/<sessionID>/
                state_<timestamp>.json, with head.json holding the latest
                as { "entry", "state": "<file>" }. A call without "in"
                continues from that latest state if it names the same
                entry, else starts fresh; "previous" names the file it
                continued from, or is null.
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

/** Flags that shape a single run's inputs or output, meaningless to a server answering many. */
export const ONE_SHOT = new Set(['--param', '--set', '--invoke', '--out', '--strip-metadata', '--compact']);
