param([string]$Mode = 'loop')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Windows TCP extended statistics via P/Invoke. Resident helper: stdin line = PID,
# output = one C<TAB>... line per established IPv4 connection, then END<TAB>count.
#
# Notes paid for in blood:
#  * IPAddress.Address is deprecated and PS 5.1's Add-Type treats that warning
#    as a COMPILE ERROR; build the DWORD from GetAddressBytes() instead.
#  * This is NOT htons: MIB_TCPROW wants a DWORD whose in-memory bytes are the
#    network-order address, which on x86 is BitConverter.ToUInt32(bytes, 0).
#    HostToNetworkOrder double-swaps and yields a row that matches nothing.
#  * SetPerTcpConnectionEStats needs a real TCP_ESTATS_DATA_RW_v0 ({BOOL Enable}),
#    not a null pointer.
Add-Type -TypeDefinition @'
using System;
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

    static uint AddrToDword(string ip)
    {
        byte[] b = IPAddress.Parse(ip).GetAddressBytes();
        if (b.Length != 4) throw new ArgumentException("not v4: " + ip);
        return BitConverter.ToUInt32(b, 0);
    }

    static uint PortToDword(int port)
    {
        return (uint)(((port & 0xFF) << 8) | ((port >> 8) & 0xFF));
    }

    static MIB_TCPROW MakeRow(string lip, int lport, string rip, int rport)
    {
        MIB_TCPROW row = new MIB_TCPROW();
        row.dwState = 5;
        row.dwLocalAddr = AddrToDword(lip);
        row.dwLocalPort = PortToDword(lport);
        row.dwRemoteAddr = AddrToDword(rip);
        row.dwRemotePort = PortToDword(rport);
        return row;
    }

    /// <summary>Enable DATA collection. Raw Win32 code, 0 = ok.</summary>
    public static uint Enable(string lip, int lport, string rip, int rport)
    {
        MIB_TCPROW row = MakeRow(lip, lport, rip, rport);
        IntPtr rw = Marshal.AllocHGlobal(1);
        try
        {
            Marshal.WriteByte(rw, 0, 1);
            return SetPerTcpConnectionEStats(ref row, TcpConnectionEstatsData, rw, 0, 1, 0);
        }
        finally { Marshal.FreeHGlobal(rw); }
    }

    /// <summary>{DataBytesIn, DataBytesOut}; null + err on failure.</summary>
    public static long[] Read(string lip, int lport, string rip, int rport, out string err)
    {
        err = "";
        MIB_TCPROW row = MakeRow(lip, lport, rip, rport);
        int size = Marshal.SizeOf(typeof(TCP_ESTATS_DATA_ROD_v0));
        IntPtr rod = Marshal.AllocHGlobal(size);
        try
        {
            for (int i = 0; i < size; i++) Marshal.WriteByte(rod, i, 0);
            uint rc = GetPerTcpConnectionEStats(ref row, TcpConnectionEstatsData,
                IntPtr.Zero, 0, 0, IntPtr.Zero, 0, 0, rod, 0, (uint)size);
            if (rc != 0) { err = "Get=" + rc; return null; }
            TCP_ESTATS_DATA_ROD_v0 d =
                (TCP_ESTATS_DATA_ROD_v0)Marshal.PtrToStructure(rod, typeof(TCP_ESTATS_DATA_ROD_v0));
            return new long[] { (long)d.DataBytesIn, (long)d.DataBytesOut };
        }
        finally { Marshal.FreeHGlobal(rod); }
    }
}
'@

$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($id)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output ('ADMIN' + [char]9 + $isAdmin)
Write-Output 'READY'

$T = [char]9
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq 'QUIT') { break }
  if ($line -eq '') { continue }

  $n = 0
  $count = 0
  if (-not [int]::TryParse($line, [ref]$n)) { Write-Output ('END' + $T + 0); continue }
  try { $conns = Get-NetTCPConnection -OwningProcess $n -State Established -ErrorAction Stop } catch { $conns = @() }
  foreach ($c in $conns) {
    try {
      $laddr = [string]$c.LocalAddress
      $raddr = [string]$c.RemoteAddress
      if ($laddr.Contains(':') -or $raddr.Contains(':')) { continue }
      $en = [TcpStats]::Enable($laddr, [int]$c.LocalPort, $raddr, [int]$c.RemotePort)
      $err = ''
      $vals = [TcpStats]::Read($laddr, [int]$c.LocalPort, $raddr, [int]$c.RemotePort, [ref]$err)
      $bin = if ($null -eq $vals) { -1 } else { $vals[0] }
      $bout = if ($null -eq $vals) { -1 } else { $vals[1] }
      Write-Output ('C' + $T + $n + $T + $laddr + $T + $c.LocalPort + $T + $raddr + $T + $c.RemotePort + $T + $en + $T + $bin + $T + $bout + $T + $err)
      $count++
    } catch { }
  }
  Write-Output ('END' + $T + $count)
}
