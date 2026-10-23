/**
 * Experiment 2: is per-connection byte accounting readable from PowerShell?
 *
 * Experiment 1 killed the obvious idea — `ReadTransferCount` is the process's
 * FILE I/O counter, so a 12 MiB download moved it by 0 bytes. Sockets are not
 * file I/O on Windows and never show up there.
 *
 * The remaining OS-level source of byte counts is TCP extended statistics
 * (`GetPerTcpConnectionEStats`), which reports DataBytesIn/Out for ONE
 * connection, keyed by the 4-tuple. This test wires that up through P/Invoke in
 * the resident helper and asks two questions:
 *
 *   1. does it return a plausible byte count at all?
 *   2. does it track a live transfer tick by tick?
 *
 * If it works, the plugin can measure a `-File` script download without ever
 * knowing which file the script writes — the thing experiment 1 could not do.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const LAB = 'D:/AIworks/dsh-download-progress/lab'
const PORT = 45781
const MB = 16
mkdirSync(path.join(LAB, 'work'), { recursive: true })

/* ---- the P/Invoke helper, as a standalone script so it can be run by hand ---- */

const HELPER_PS1 = String.raw`
param([string]$Mode = 'loop')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;

public class TcpStats
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MIB_TCPROW
    {
        public uint dwState;
        public uint dwLocalAddr;
        public uint dwLocalPort;
        public uint dwRemoteAddr;
        public uint dwRemotePort;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TCP_ESTATS_DATA_ROD_v0
    {
        public ulong DataBytesOut;
        public ulong DataSegsOut;
        public ulong DataBytesIn;
        public ulong DataSegsIn;
        public ulong SegsOut;
        public ulong SegsIn;
        public uint  SoftErrors;
        public uint  SoftErrorReason;
        public uint  SndUna;
        public uint  SndNxt;
        public uint  SndMax;
        public ulong ThruBytesAcked;
        public uint  RcvNxt;
        public ulong ThruBytesReceived;
    }

    const int TcpConnectionEstatsData = 1;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern uint GetPerTcpConnectionEStats(
        ref MIB_TCPROW Row, int EstatsType,
        IntPtr Rw, uint RwVersion, uint RwSize,
        IntPtr Ros, uint RosVersion, uint RosSize,
        IntPtr Rod, uint RodVersion, uint RodSize);

    [DllImport("iphlpapi.dll", SetLastError = true)]
    static extern uint SetPerTcpConnectionEStats(
        ref MIB_TCPROW Row, int EstatsType,
        IntPtr Rw, uint RwVersion, uint RwSize,
        uint Offset);

    static uint Ntohs(uint net) { return (uint)IPAddress.NetworkToHostOrder((int)net); }

    /// <summary>Read DataBytesIn/Out for one connection. 0 = success.</summary>
    public static long[] Read(string localIp, int localPort, string remoteIp, int remotePort, out string err)
    {
        err = "";
        MIB_TCPROW row = new MIB_TCPROW();
        row.dwState = 5; // MIB_TCP_STATE_ESTAB
        row.dwLocalAddr  = (uint)IPAddress.HostToNetworkOrder((int)IPAddress.Parse(localIp).Address);
        row.dwLocalPort  = (uint)((localPort & 0xFF) << 8 | (localPort >> 8) & 0xFF);
        row.dwRemoteAddr = (uint)IPAddress.HostToNetworkOrder((int)IPAddress.Parse(remoteIp).Address);
        row.dwRemotePort = (uint)((remotePort & 0xFF) << 8 | (remotePort >> 8) & 0xFF);

        // Enable the DATA stats on this connection first; Get fails with
        // ERROR_INVALID_PARAMETER on a connection that was never enabled.
        uint en = SetPerTcpConnectionEStats(ref row, TcpConnectionEstatsData, IntPtr.Zero, 0, 0, 0);
        if (en != 0 && en != 65 /* ERROR_BAD_NETPATH is benign here */)
            err = "Set=" + en;

        int size = Marshal.SizeOf(typeof(TCP_ESTATS_DATA_ROD_v0));
        IntPtr rod = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(rod, i, 0);
            uint rc = GetPerTcpConnectionEStats(ref row, TcpConnectionEstatsData,
                IntPtr.Zero, 0, 0, IntPtr.Zero, 0, 0, rod, 0, (uint)size);
            if (rc != 0) { err += " Get=" + rc; return null; }
            TCP_ESTATS_DATA_ROD_v0 d =
                (TCP_ESTATS_DATA_ROD_v0)Marshal.PtrToStructure(rod, typeof(TCP_ESTATS_DATA_ROD_v0));
            return new long[] { (long)d.DataBytesIn, (long)d.DataBytesOut };
        }
        finally { Marshal.FreeHGlobal(rod); }
    }
}
'@

Write-Output 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line -eq '') { continue }

  # Request: "<pid>" -> report every established TCP connection of that process.
  $n = 0
  if (-not [int]::TryParse($line, [ref]$n)) { Write-Output ('END' + [char]9 + 0); continue }
  $count = 0
  try {
    $conns = Get-NetTCPConnection -OwningProcess $n -State Established -ErrorAction Stop
  } catch { $conns = @() }
  foreach ($c in $conns) {
    try {
      $laddr = [string]$c.LocalAddress
      $raddr = [string]$c.RemoteAddress
      if ($laddr -eq '::' -or $raddr -eq '::' -or $laddr.Contains(':') -or $raddr.Contains(':')) { continue }
      $err = ''
      $vals = [TcpStats]::Read($laddr, [int]$c.LocalPort, $raddr, [int]$c.RemotePort, [ref]$err)
      if ($null -eq $vals) {
        Write-Output ('C' + [char]9 + $n + [char]9 + $laddr + [char]9 + $c.LocalPort + [char]9 + $raddr + [char]9 + $c.RemotePort + [char]9 + '-1' + [char]9 + '-1' + [char]9 + $err)
      } else {
        Write-Output ('C' + [char]9 + $n + [char]9 + $laddr + [char]9 + $c.LocalPort + [char]9 + $raddr + [char]9 + $c.RemotePort + [char]9 + $vals[0] + [char]9 + $vals[1] + [char]9 + $err)
      }
      $count++
    } catch { }
  }
  Write-Output ('END' + [char]9 + $count)
}
`

const helperPath = path.join(LAB, 'tcp-helper.ps1')
writeFileSync(helperPath, HELPER_PS1)

/* ---- run one instrumented download ---- */

function startHelper() {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  const rl = createInterface({ input: child.stdout })
  const errLines = []
  child.stderr.on('data', (d) => errLines.push(String(d)))
  let pending = null
  let done = null
  let readyResolve = null
  const ready = new Promise((r) => {
    readyResolve = r
  })
  rl.on('line', (line) => {
    if (line === 'READY') {
      if (readyResolve) {
        readyResolve()
        readyResolve = null
      }
      return
    }
    if (line.startsWith('C\t') && pending) {
      pending.push(line.split('\t'))
      return
    }
    if (line.startsWith('END\t') && pending) {
      const out = pending
      pending = null
      if (done) {
        done(out)
        done = null
      }
    }
  })
  return {
    ready,
    errors: () => errLines.join(''),
    query(pid) {
      return new Promise((res) => {
        pending = []
        done = res
        child.stdin.write(String(pid) + '\n')
      })
    },
    close() {
      try {
        child.stdin.write('QUIT\n')
      } catch {}
      child.kill()
    },
  }
}

const server = spawn(process.execPath, [path.join(LAB, 'http-slow.mjs')], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, LAB_PORT: String(PORT), LAB_RATE: String(8 * 1024 * 1024) },
})
await new Promise((res) => {
  const rl = createInterface({ input: server.stdout })
  rl.on('line', (l) => {
    console.log('server:', l)
    res()
  })
})

const helper = startHelper()
await helper.ready
console.log('tcp helper ready (Add-Type compiled)')

// curl.exe in a child process: the connection belongs to curl's PID.
const out = path.join(LAB, 'work', 'tcp-probe.bin')
const dl = spawn(
  'curl.exe',
  ['-s', '-L', '--fail', '-o', out, `http://127.0.0.1:${PORT}/file?mb=${MB}`],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
)
const dlErr = []
dl.stderr.on('data', (d) => dlErr.push(String(d)))

const t0 = Date.now()
const rows = []
const timer = setInterval(async () => {
  const conns = await helper.query(dl.pid)
  const totalIn = conns.reduce((sum, c) => sum + Math.max(0, Number(c[8]) || 0), 0)
  rows.push({ t: Date.now() - t0, conns: conns.length, bytesIn: totalIn, raw: conns })
}, 1000)

const code = await new Promise((res) => dl.on('exit', res))
clearInterval(timer)
helper.close()
server.kill()

console.log(`\ncurl exit=${code} ${Date.now() - t0}ms, expected ${MB} MiB`)
if (dlErr.length) console.log('curl stderr:', dlErr.join('').trim())
console.log('\n  t(s)  conns        dataBytesIn    delta        MiB')
let prev = 0
for (const r of rows) {
  const delta = r.bytesIn - prev
  prev = r.bytesIn
  console.log(
    `  ${String(Math.round(r.t / 1000)).padStart(4)}  ${String(r.conns).padStart(5)}  ${String(r.bytesIn).padStart(15)}  ${String(delta).padStart(10)}  ${(r.bytesIn / 1048576).toFixed(2)}`,
  )
}
const last = rows[rows.length - 1]
console.log(`\n最终 dataBytesIn=${last ? last.bytesIn : 'n/a'}  / 期望 ${MB * 1048576}`)
if (last && last.raw.length) {
  console.log('最后一行原始:', JSON.stringify(last.raw))
}
console.log('\nhelper stderr:', helper.errors().trim() || '(clean)')
writeFileSync(path.join(LAB, 'work', 'result2.json'), JSON.stringify(rows, null, 2))
