/** A script beyond this size is not a download script, and must not be slurped. */
export const MAX_SCRIPT_BYTES = 512 * 1024

/** How deep `$a = $b = $c` chains are followed before giving up. */
export const MAX_DEPTH = 6

/**
 * Flags whose next argument is a path being written.
 *
 * `-Path` is included for `Invoke-WebRequest -Path` (older syntax); `-Destination`
 * covers `Start-BitsTransfer`.
 */
export const OUT_FLAG_RE =
  /(?:^|[\s;|&({])(?:-OutFile|-Destination|-Path|-o|--output)(?=[\s=:]|$)/gi

/**
 * `-File <script>` on a powershell/`pwsh` command line.
 *
 * The bare branch stops at every character that ends a PowerShell statement or
 * redirects a stream (`; | & < >`). Without that it swallowed whatever followed
 * the path: `powershell -File D:\x\get.ps1; echo ok` captured `D:\x\get.ps1;`,
 * `statSync` threw ENOENT, and the whole card was dropped — an agent that chains
 * one `;` after the script (the normal way to echo its exit code) got no card at
 * all while an identical command without the trailing statement worked.
 *
 * Windows forbids `< > : " | ? *` in file names, and a bare `;` or `&` would be
 * a statement separator rather than part of the path, so nothing legitimate is
 * lost. Quoted branches still accept every character.
 */
export const FILE_FLAG_RE =
  /(?:^|\s)-File(?:Path)?(?:\s+|=)("([^"]+)"|'([^']+)'|([^\s;|&<>]+))/i
