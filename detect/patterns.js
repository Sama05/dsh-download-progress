/**
 * Command-line patterns, and the two token readers built on them.
 *
 * Pure data: every regex here is matched against a command-line string, so this
 * module has no imports at all. Keeping them together is deliberate — the flags
 * are the plugin's entire knowledge of curl/wget/aria2c/PowerShell syntax, and a
 * rule read out of context is how `-O` and `-o` got swapped in the first place.
 */

/** `-OutFile` is what turns an Invoke-WebRequest into something sampleable. */
export const PS_OUTFILE_RE = /(?:^|\s)-OutFile(?=\s)/i

/**
 * A script run by `powershell -File <script>` / `pwsh -File <script>`.
 *
 * The whole command line is `powershell -File x.ps1`: the head program is a
 * shell, no downloader name appears, and no `-OutFile` appears, so every test
 * below misses it and the dispatch gets no card at all — even when the script's
 * one job is to download a 5 GB ISO. `-File` is the only way a shell names a
 * script to run, so it is a cheap and precise signal.
 *
 * This stays a pure string test. Whether the script really downloads anything is
 * answered by reading it in `beginTask()` (see script.js), and a script that does
 * not is dropped there rather than guessed at here.
 *
 * `Start-Process -FilePath 'curl.exe'` is NOT this shape: it is unwrapped by
 * `expandLauncher()` into the launched program itself, and the head is then
 * `curl`, not a shell.
 */
export const PS_SCRIPT_FILE_RE = /(?:^|\s)-File(?:Path)?(?=\s)/i

/**
 * Where `git clone` starts, for slicing out its positional arguments.
 * Deliberately looser than {@link isGitClone}: this only locates the command, it
 * never decides whether a card is raised.
 */
export const GIT_CLONE_RE = /\bgit\b[^|;&]*?\bclone\b/i

/** Package managers that stream a known amount of traffic into a cache. */
export const PKG_RE =
  /\b(pnpm\s+(?:add|i|install)|npm\s+(?:i|install|add)|yarn\s+add|pip\s+install|uv\s+(?:add|pip)|docker\s+pull|ollama\s+pull)\b/i

/**
 * How much of a command line is worth scanning.
 *
 * Agents sometimes inline whole files into `pwsh -Command "..."`. Every pattern
 * here is anchored near the start, so the tail is pure cost: a large regex pass
 * on the host main thread, once per dispatch, on data that cannot match.
 */
export const MAX_SCAN_CHARS = 20000

/**
 * `curl -o <path>` / `--output <path>` / `--output-document <path>`.
 * Lowercase `-o` only: uppercase `-O` means "name it after the URL", which is
 * handled separately.
 */
export const CURL_OUTFILE_RE = /(?:^|\s)(?:-o|--output|--output-document)\s+("([^"]+)"|'([^']+)'|(\S+))/g

/** PowerShell `-OutFile <path>`, same quoting rules. */
export const PS_OUTFILE_ARG_RE = /(?:^|\s)-OutFile\s+("([^"]+)"|'([^']+)'|(\S+))/gi

/** `curl -O` / `--remote-name`: the target is `cwd/basename(url)`. */
export const CURL_REMOTE_NAME_RE = /(?:^|\s)(?:-O|--remote-name)(?=\s|$)/

/**
 * `curl -T <file> <url>` / `--upload-file`: the bytes travel the other way.
 *
 * Treating this as a download put a card on the *response* file (`-o resp.txt`),
 * which stays at 0 B because the response is a few hundred bytes of JSON while
 * the real transfer is uploading — a bar that can never move, on a transfer
 * nobody is watching. With no `-o` the card had no target at all and sat on
 * "载入中..." for the whole upload.
 *
 * `-T` is curl-specific on purpose: in `wget`, `-T` means `--timeout`, so testing
 * the flag on any segment would turn `wget -T 60 -O f u` into an upload.
 */
export const CURL_UPLOAD_RE = /(?:^|\s)(?:-T|--upload-file)(?=[\s=]|$)/

/**
 * wget's `-O` means "write to this file", which is the *opposite* of curl's `-O`.
 * Treating the two the same used to put `wget -O out.bin …` on a card watching
 * the URL's own basename — a file the transfer never touches.
 *
 * The `--output-document=path` spelling is left alone on purpose: it is rare,
 * and a half-parsed flag would be worse than the honest "unresolved".
 */
export const WGET_OUTFILE_RE = /(?:^|\s)(?:-O|--output-document)\s+("([^"]+)"|'([^']+)'|(\S+))/g

/**
 * aria2c names its output with `-o <file>` *relative to the download directory*
 * (`-d`, defaulting to the cwd), and `--out=<file>`.
 *
 * The two-part split matters: `-d D:\Downloads -o win.iso` writes
 * `D:\Downloads\win.iso`, never `cwd\win.iso`. Ignoring `-d` puts the card on a
 * file aria2c never opens, which is the same silent-0 % bug as a bad guess.
 */
export const ARIA_OUTFILE_RE = /(?:^|\s)(?:-o|--out[= ])\s*("([^"]+)"|'([^']+)'|(\S+))/g
export const ARIA_DIR_RE = /(?:^|\s)(?:-d|--dir[= ])\s*("([^"]+)"|'([^']+)'|(\S+))/g

/**
 * `aria2c -i list.txt` / `--input-file=list.txt`: the batch manifest.
 *
 * Only consulted when the segment head is aria2c (see `aria2InputSpec`), so
 * curl's unrelated `-i`/`--include` cannot be mistaken for a manifest.
 */
export const ARIA_INPUT_RE = /(?:^|\s)(?:-i|--input-file[= ])\s*("([^"]+)"|'([^']+)'|(\S+))/g

/** Flags that name the file a downloader writes. */
export const OUTFILE_FLAGS = new Set(['-o', '--output', '--output-document', '-outfile'])

/** `-ArgumentList …` / `-Args …`: the array form hides the flag behind commas. */
export const ARG_LIST_RE = /-(?:ArgumentList|Args)\s+/i

/**
 * Pull the path out of every match of a flag pattern.
 * Uses `matchAll` rather than a shared `.exec()` loop: a `/g` regex carries
 * `lastIndex` between calls, and a module-level constant reused across calls
 * would silently skip the first match on the second call.
 *
 * @param {string} command
 * @param {RegExp} pattern must carry the `g` flag
 * @returns {string[]} raw, still-quoted tokens
 */
export function flagValues(command, pattern) {
  const out = []
  for (const match of command.matchAll(pattern)) {
    const value = match[2] || match[3] || match[4]
    if (value) out.push(value)
  }
  return out
}

/**
 * Split a PowerShell argument list into tokens.
 *
 * `Start-Process -ArgumentList '-L','-o','out.bin','https://…'` hands the child
 * process an array; the `-o` and its value are two comma-separated items, so the
 * whitespace-anchored flag regexes cannot see them. Quoted and bare tokens are
 * both accepted.
 *
 * @param {string} value text after `-ArgumentList`
 * @returns {string[]}
 */
export function psArrayTokens(value) {
  const tokens = []
  for (const match of value.matchAll(/'([^']*)'|"([^"]*)"|([^,\s]+)/g)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token !== undefined) tokens.push(token)
  }
  return tokens
}
