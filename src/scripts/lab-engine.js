/**
 * 实验台引擎：三关纯前端状态机。
 *
 * 这里不碰 DOM，也不发起任何网络请求。每条命令只读写 session.state，
 * 页面负责把返回的行渲染到终端里。命令集是手写的子集，不是真 shell：
 * 没实现的命令会明确回 `command not found`，不会假装执行成功。
 *
 * 关卡顺序按站内笔记的依赖排：先块设备，再防火墙，最后权限。
 * 每关的 article 字段对应真实文章 id，页面用它拼「读完去哪」。
 */

const clone = (value) =>
  typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

const L = (t, tone) => (tone ? { t, tone } : { t });
const DIM = (t) => L(t, 'dim');
const OK = (t) => L(t, 'ok');
const ERR = (t) => L(t, 'err');
const WARN = (t) => L(t, 'warn');

/** 按空白切分，单双引号内的空格保留 */
export function tokenize(input) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of String(input).trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const pad = (s, n) => String(s).padEnd(n);

/* ---------- 通用内置命令 ---------- */

const OS_RELEASE = [
  'NAME="Rocky Linux"',
  'VERSION="9.4 (Blue Onyx)"',
  'ID="rocky"',
  'ID_LIKE="rhel centos fedora"',
  'VERSION_ID="9.4"',
  'PLATFORM_ID="platform:el9"',
  'PRETTY_NAME="Rocky Linux 9.4 (Blue Onyx)"',
  'ANSI_COLOR="0;32"',
  'CPE_NAME="cpe:/o:rocky:rocky:9::baseos"',
];

function builtin(_session, cmd, args) {
  switch (cmd) {
    case 'whoami':
      return [L('root')];
    case 'pwd':
      return [L('/root')];
    case 'hostname':
      return [L('lab')];
    case 'date':
      return [L('Sun Oct 26 14:32:07 CST 2026')];
    case 'uname':
      return [
        L(
          'Linux lab 5.14.0-427.el9.x86_64 #1 SMP PREEMPT_DYNAMIC Wed Apr 17 08:00:00 UTC 2026 x86_64 GNU/Linux',
        ),
      ];
    case 'echo':
      return [L(args.join(' '))];
    case 'cat':
      if (args[0] === '/etc/os-release') return OS_RELEASE.map((l) => L(l));
      return [ERR(`cat: ${args[0] ?? ''}: No such file or directory`)];
    case 'man':
      return [DIM('实验台没有手册页。输入 help 看这一关实现了哪些命令。')];
    default:
      return null;
  }
}

/* ---------- LVM ---------- */

const SIZE_IN_GB = { k: 1 / 1024 / 1024, m: 1 / 1024, g: 1, t: 1024 };

function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)([kKmMgGtT])$/.exec(String(text ?? ''));
  if (!m) return null;
  return Number(m[1]) * SIZE_IN_GB[m[2].toLowerCase()];
}

function shortSize(gb) {
  if (gb >= 100) return `${Math.round(gb)}T`;
  if (gb >= 1) return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}G`;
  return `${Math.round(gb * 1024)}M`;
}

function longSize(gb) {
  return `${gb.toFixed(2)}g`;
}

function vgUsed(state, name) {
  return state.lvs.filter((lv) => lv.vg === name).reduce((sum, lv) => sum + lv.size, 0);
}

function resolveLv(state, path) {
  const direct = /^\/dev\/([^/]+)\/([^/]+)$/.exec(path);
  if (direct && !['sda', 'sdb', 'sdc'].includes(direct[1])) {
    return state.lvs.find((lv) => lv.vg === direct[1] && lv.name === direct[2]);
  }
  const mapper = /^\/dev\/mapper\/([^/]+)$/.exec(path);
  if (mapper) {
    const [vg, ...rest] = mapper[1].split('-');
    return state.lvs.find((lv) => lv.vg === vg && lv.name === rest.join('-'));
  }
  return undefined;
}

const LVM_LEVEL = {
  id: 'lvm',
  index: '01',
  title: '一块裸盘',
  kicker: 'LVM',
  article: '2026-09-21-lvm-thin-vdo-stratis',
  articleTitle: 'LVM、Thin、VDO 与 Stratis',
  prompt: 'root@lab:~#',
  intro: [
    DIM('# 实验台 01 · LVM'),
    L('你有一块空盘 /dev/sdb（20G）。目标：把它变成 5G 的 xfs 逻辑卷，挂到 /var/www。'),
    DIM('# 输入 help 看命令，hint 看下一步。所有输出都是模拟的。'),
    '',
  ],
  help: [
    ['lsblk', '列出块设备'],
    ['pvs / vgs / lvs', '查看物理卷 / 卷组 / 逻辑卷'],
    ['pvcreate <盘>', '把一块盘做成物理卷'],
    ['vgcreate <卷组> <盘>', '创建卷组'],
    ['lvcreate -L 5G -n <名> <卷组>', '创建逻辑卷'],
    ['mkfs.xfs <设备>', '格式化为 xfs'],
    ['mount <设备> <目录>', '挂载'],
    ['df -h', '查看挂载与用量'],
    ['clear / help / hint', '清屏 / 帮助 / 提示'],
  ],
  makeState: () => ({
    disks: [
      { name: '/dev/sda', size: 40, system: true },
      { name: '/dev/sdb', size: 20 },
      { name: '/dev/sdc', size: 20 },
    ],
    pvs: [],
    vgs: [],
    lvs: [],
    dirs: ['/root', '/var/www'],
  }),
  commands: {
    lsblk(state) {
      /* 先收集所有行，再按最长的设备名定 NAME 列宽。
         写死 7 列时，└─vg_data-lv_web 这种长名字会把后面的列顶到下一行。 */
      const entries = [];
      let minor = 0;
      let lvMinor = 0;
      for (const disk of state.disks) {
        const name = disk.name.replace('/dev/', '');
        entries.push({
          name,
          majmin: `8:${minor}`,
          size: shortSize(disk.size),
          type: 'disk',
          mount: '',
        });
        minor += 16;
        if (name === 'sda') {
          entries.push({ name: '└─sda1', majmin: '8:1', size: '40G', type: 'part', mount: '/' });
        }
        const pv = state.pvs.find((p) => p.disk === disk.name);
        if (pv?.vg) {
          const vg = state.vgs.find((v) => v.name === pv.vg);
          for (const lv of state.lvs.filter((l) => l.vg === vg.name)) {
            entries.push({
              name: `└─${vg.name}-${lv.name}`,
              majmin: `253:${lvMinor++}`,
              size: shortSize(lv.size),
              type: 'lvm',
              mount: lv.mount ?? '',
            });
          }
        }
      }

      const nameW = Math.max(7, ...entries.map((entry) => entry.name.length)) + 2;
      const row = (entry) =>
        `${pad(entry.name, nameW)}${pad(entry.majmin, 8)}${pad('0', 3)}${pad(entry.size, 6)}${pad(
          '0',
          3,
        )}${entry.type}${entry.mount ? `  ${entry.mount}` : ''}`;

      return [
        L(`${pad('NAME', nameW)}${pad('MAJ:MIN', 8)}${pad('RM', 3)}${pad('SIZE', 6)}${pad('RO', 3)}TYPE`),
        ...entries.map((entry) => L(row(entry))),
      ];
    },

    pvs(state) {
      const rows = ['  PV          VG       Fmt  Attr PSize   PFree'];
      for (const pv of state.pvs) {
        const vg = state.vgs.find((v) => v.name === pv.vg);
        const disk = state.disks.find((d) => d.name === pv.disk);
        const free = vg ? vg.size - vgUsed(state, vg.name) : disk.size;
        rows.push(
          `  ${pad(pv.disk, 11)} ${pad(pv.vg ?? '', 8)} lvm2 ${pv.vg ? 'a--' : '---'}  ${longSize(
            disk.size,
          ).padStart(7)}  ${longSize(free).padStart(7)}`,
        );
      }
      return rows.map((row) => L(row));
    },

    vgs(state) {
      const rows = ['  VG       #PV #LV #SN Attr   VSize   VFree'];
      for (const vg of state.vgs) {
        const pvCount = state.pvs.filter((p) => p.vg === vg.name).length;
        const lvCount = state.lvs.filter((l) => l.vg === vg.name).length;
        const free = vg.size - vgUsed(state, vg.name);
        rows.push(
          `  ${pad(vg.name, 8)}   ${pvCount}   ${lvCount}   0 wz--n- ${longSize(vg.size).padStart(7)} ${longSize(
            free,
          ).padStart(7)}`,
        );
      }
      return rows.map((row) => L(row));
    },

    lvs(state) {
      const rows = [
        '  LV       VG       Attr       LSize  Pool Origin Data%  Meta%  Move Log Cpy%Sync Convert',
      ];
      for (const lv of state.lvs) {
        rows.push(
          `  ${pad(lv.name, 8)} ${pad(lv.vg, 8)} ${lv.mount ? '-wi-ao----' : '-wi-a-----'} ${longSize(
            lv.size,
          ).padStart(6)}`,
        );
      }
      return rows.map((row) => L(row));
    },

    pvcreate(state, args) {
      const devices = args.filter((a) => !a.startsWith('-'));
      if (!devices.length) return [DIM('用法：pvcreate /dev/sdb')];
      const out = [];
      for (const device of devices) {
        const disk = state.disks.find((d) => d.name === device);
        if (!disk) {
          out.push(ERR(`  No device found for "${device}".`));
          continue;
        }
        if (disk.system) {
          out.push(ERR(`  Device ${device} is in use by the system.`));
          out.push(DIM('  换一块空盘：/dev/sdb 或 /dev/sdc。'));
          continue;
        }
        if (state.pvs.some((p) => p.disk === device)) {
          out.push(WARN(`  Device "${device}" is already a physical volume.`));
          continue;
        }
        state.pvs.push({ disk: device, vg: null });
        out.push(OK(`  Physical volume "${device}" successfully created.`));
      }
      return out;
    },

    vgcreate(state, args) {
      const [name, device] = args.filter((a) => !a.startsWith('-'));
      if (!name || !device) return [DIM('用法：vgcreate vg_data /dev/sdb')];
      if (!/^[A-Za-z0-9_]+$/.test(name)) return [ERR(`  Invalid volume group name "${name}".`)];
      if (state.vgs.some((v) => v.name === name)) return [ERR(`  Volume group "${name}" already exists.`)];
      const pv = state.pvs.find((p) => p.disk === device);
      if (!pv) {
        return [ERR(`  Physical volume "${device}" not found.`), DIM('  先执行 pvcreate。')];
      }
      if (pv.vg) return [ERR(`  Physical volume "${device}" is already in volume group "${pv.vg}".`)];
      const disk = state.disks.find((d) => d.name === device);
      state.vgs.push({ name, size: disk.size });
      pv.vg = name;
      return [OK(`  Volume group "${name}" successfully created.`)];
    },

    lvcreate(state, args) {
      let sizeArg = '';
      let nameArg = '';
      const positional = [];
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i];
        if (a === '-L' || a === '--size') sizeArg = args[++i] ?? '';
        else if (a.startsWith('-L')) sizeArg = a.slice(2);
        else if (a === '-n' || a === '--name') nameArg = args[++i] ?? '';
        else if (a.startsWith('-n')) nameArg = a.slice(2);
        else if (!a.startsWith('-')) positional.push(a);
      }
      const vgName = positional[0];
      if (!sizeArg || !nameArg || !vgName) {
        return [DIM('用法：lvcreate -L 5G -n lv_web vg_data')];
      }
      const vg = state.vgs.find((v) => v.name === vgName);
      if (!vg) return [ERR(`  Volume group "${vgName}" not found.`)];
      const size = parseSize(sizeArg);
      if (!size) return [ERR(`  Invalid argument for -L: "${sizeArg}".`)];
      const free = vg.size - vgUsed(state, vgName);
      if (size > free) {
        const freeExt = Math.floor(free * 256);
        const needExt = Math.ceil(size * 256);
        return [
          ERR(
            `  Volume group "${vgName}" has insufficient free space (${freeExt} extents): ${needExt} required.`,
          ),
        ];
      }
      if (state.lvs.some((lv) => lv.vg === vgName && lv.name === nameArg)) {
        return [ERR(`  Logical volume "${nameArg}" already exists in volume group "${vgName}".`)];
      }
      state.lvs.push({ name: nameArg, vg: vgName, size, fs: null, mount: null });
      return [OK(`  Logical volume "${nameArg}" created.`)];
    },

    'mkfs.xfs'(state, args) {
      const force = args.includes('-f') || args.includes('-F');
      const path = args.find((a) => !a.startsWith('-'));
      if (!path) return [DIM('用法：mkfs.xfs /dev/vg_data/lv_web')];
      const lv = resolveLv(state, path);
      if (!lv) return [ERR(`mkfs.xfs: cannot open ${path}: No such file or directory`)];
      if (lv.fs && !force) {
        return [
          ERR(`mkfs.xfs: ${path} appears to contain an existing filesystem (${lv.fs}).`),
          DIM('mkfs.xfs: Use the -f option to force overwrite.'),
        ];
      }
      lv.fs = 'xfs';
      return [
        DIM(`meta-data=${path.padEnd(22)} isize=512    agcount=4, agsize=327680 blks`),
        DIM('         =                       sectsz=512   attr=2, projid32bit=1'),
        DIM('data     =                       bsize=4096   blocks=1310720, imaxpct=25'),
        DIM('naming   =version 2              bsize=4096   ascii-ci=0, ftype=1'),
        DIM('log      =internal log           bsize=4096   blocks=16384, version=2'),
        DIM('realtime =none                   extsz=4096   blocks=0, rtextents=0'),
      ];
    },

    mount(state, args) {
      const [source, target] = args.filter((a) => !a.startsWith('-'));
      if (!source || !target) return [DIM('用法：mount /dev/vg_data/lv_web /var/www')];
      const lv = resolveLv(state, source);
      if (!lv) return [ERR(`mount: ${source}: special device does not exist.`)];
      if (!state.dirs.includes(target)) return [ERR(`mount: ${target}: mount point does not exist.`)];
      if (!lv.fs) {
        return [
          ERR(
            `mount: ${target}: wrong fs type, bad option, bad superblock on ${source}, missing codepage or helper program, or other error.`,
          ),
          DIM('  这块逻辑卷还没有文件系统，先 mkfs.xfs。'),
        ];
      }
      const occupied = state.lvs.find((l) => l.mount === target);
      if (occupied) return [ERR(`mount: ${target}: ${source} already mounted on ${target}.`)];
      lv.mount = target;
      return [];
    },

    umount(state, args) {
      const target = args.find((a) => !a.startsWith('-'));
      const lv = state.lvs.find((l) => l.mount === target);
      if (!lv) return [ERR(`umount: ${target ?? ''}: not mounted.`)];
      lv.mount = null;
      return [];
    },

    df(state, args) {
      const rows = ['Filesystem                    Size  Used Avail Use% Mounted on'];
      rows.push('/dev/mapper/rl-root            36G   12G   24G  34% /');
      for (const lv of state.lvs) {
        if (!lv.mount) continue;
        const size = `${lv.size.toFixed(1)}G`;
        rows.push(
          `${pad(`/dev/mapper/${lv.vg}-${lv.name}`, 28)} ${size.padStart(5)}   68M ${`${(lv.size - 0.07).toFixed(
            1,
          )}G`.padStart(5)}   2% ${lv.mount}`,
        );
      }
      return rows.map((row) => L(row));
    },
  },
  objectives: [
    {
      id: 'pv',
      label: '在 /dev/sdb 上创建物理卷',
      hint: 'pvcreate /dev/sdb',
      test: (s) => s.pvs.some((p) => p.disk === '/dev/sdb'),
    },
    {
      id: 'vg',
      label: '创建卷组 vg_data',
      hint: 'vgcreate vg_data /dev/sdb',
      test: (s) => s.vgs.some((v) => v.name === 'vg_data'),
    },
    {
      id: 'lv',
      label: '创建 5G 逻辑卷 lv_web',
      hint: 'lvcreate -L 5G -n lv_web vg_data',
      test: (s) => s.lvs.some((l) => l.name === 'lv_web' && l.vg === 'vg_data' && l.size >= 5),
    },
    {
      id: 'mount',
      label: '格式化为 xfs 并挂到 /var/www',
      hint: 'mkfs.xfs /dev/vg_data/lv_web，然后 mount /dev/vg_data/lv_web /var/www',
      test: (s) => s.lvs.some((l) => l.name === 'lv_web' && l.fs === 'xfs' && l.mount === '/var/www'),
    },
  ],
};

/* ---------- firewalld ---------- */

const KNOWN_SERVICES = [
  'ssh',
  'http',
  'https',
  'ftp',
  'smtp',
  'dns',
  'dhcp',
  'dhcpv6',
  'dhcpv6-client',
  'nfs',
  'mountd',
  'rpc-bind',
  'samba',
  'mysql',
  'postgresql',
  'redis',
  'cockpit',
];

const FIREWALL_LEVEL = {
  id: 'firewall',
  index: '02',
  title: '只开一个口',
  kicker: 'firewalld',
  article: '2026-09-21-firewall-firewalld-iptables-nftables',
  articleTitle: '防火墙：firewalld、iptables 与 nftables',
  prompt: 'root@lab:~#',
  intro: [
    DIM('# 实验台 02 · firewalld'),
    L('目标：对外放行 http 和 8080/tcp，并且 reload 之后仍然有效。'),
    DIM('# 这一关真正要记住的是 --permanent 和 --reload 的关系。'),
    DIM('# 输入 help 看命令，hint 看下一步。'),
    '',
  ],
  help: [
    ['firewall-cmd --state', '查看服务是否在运行'],
    ['firewall-cmd --list-all', '查看当前 zone 的运行时规则'],
    ['firewall-cmd --permanent --list-all', '查看永久配置'],
    ['firewall-cmd --add-service=http', '放行服务（外加 --permanent 写配置）'],
    ['firewall-cmd --add-port=8080/tcp', '放行端口（同样支持 --permanent）'],
    ['firewall-cmd --remove-service=x', '移除服务'],
    ['firewall-cmd --reload', '把永久配置载入运行时'],
    ['systemctl status firewalld', '查看服务状态'],
    ['clear / help / hint', '清屏 / 帮助 / 提示'],
  ],
  makeState: () => ({
    running: true,
    zone: 'public',
    iface: 'eth0',
    runtime: { services: ['ssh', 'dhcpv6-client'], ports: [] },
    permanent: { services: ['ssh', 'dhcpv6-client'], ports: [] },
    reloads: 0,
  }),
  commands: {
    systemctl(state, args) {
      const action = args[0];
      if (!['status', 'start', 'stop', 'restart', 'reload'].includes(action)) {
        return [DIM('用法：systemctl status firewalld')];
      }
      if (action === 'status') {
        if (!state.running) {
          return [
            L('○ firewalld.service - firewalld - dynamic firewall daemon'),
            DIM('     Loaded: loaded (/usr/lib/systemd/system/firewalld.service; enabled)'),
            ERR('     Active: inactive (dead)'),
          ];
        }
        return [
          L('● firewalld.service - firewalld - dynamic firewall daemon'),
          DIM('     Loaded: loaded (/usr/lib/systemd/system/firewalld.service; enabled; preset: enabled)'),
          OK('     Active: active (running) since Sun 2026-10-26 14:02:11 CST; 30min ago'),
          DIM('       Docs: man:firewalld(1)'),
        ];
      }
      if (action === 'stop') {
        state.running = false;
        return [];
      }
      if (action === 'start') {
        state.running = true;
        return [];
      }
      state.runtime = clone(state.permanent);
      state.reloads += 1;
      return [OK('success')];
    },

    'firewall-cmd'(state, args) {
      if (!args.length) {
        return [
          DIM('用法: firewall-cmd [OPTIONS...]'),
          DIM('  --state              --list-all           --reload'),
          DIM('  --add-service=NAME   --add-port=PORT/PROTO'),
          DIM('  以上都可以配合 --permanent 使用。'),
        ];
      }
      if (args.includes('--state')) {
        return [state.running ? OK('running') : ERR('not running')];
      }
      if (!state.running) {
        return [ERR('FirewallD is not running')];
      }

      const permanent = args.includes('--permanent');
      const book = permanent ? state.permanent : state.runtime;

      if (args.includes('--reload')) {
        state.runtime = clone(state.permanent);
        state.reloads += 1;
        return [OK('success')];
      }

      if (args.includes('--list-all')) {
        return [
          L(`${state.zone} (active)`),
          L('  target: default'),
          L('  icmp-block-inversion: no'),
          L(`  interfaces: ${state.iface}`),
          L('  sources:'),
          L(`  services: ${book.services.join(' ')}`),
          L(`  ports: ${book.ports.join(' ')}`),
          L('  protocols:'),
          L('  forward: no'),
          L('  masquerade: no'),
          L('  forward-ports:'),
          L('  source-ports:'),
          L('  icmp-blocks:'),
          L('  rich rules:'),
          permanent ? DIM('  # 这是永久配置（--permanent），不是当前运行时。') : DIM('  # 这是当前运行时规则。'),
        ];
      }

      const addService = args.find((a) => a.startsWith('--add-service='));
      const removeService = args.find((a) => a.startsWith('--remove-service='));
      const addPort = args.find((a) => a.startsWith('--add-port='));
      const removePort = args.find((a) => a.startsWith('--remove-port='));

      const finish = (message) => {
        if (permanent) {
          return [OK(message), DIM('  # 已写入永久配置；当前运行时未变，--reload 后才生效。')];
        }
        return [OK(message)];
      };

      if (addService) {
        const name = addService.split('=')[1] ?? '';
        if (!KNOWN_SERVICES.includes(name)) return [ERR(`Error: INVALID_SERVICE: ${name}`)];
        if (book.services.includes(name)) return [WARN(`Warning: ALREADY_ENABLED: ${name}`)];
        book.services.push(name);
        book.services.sort();
        return finish('success');
      }

      if (removeService) {
        const name = removeService.split('=')[1] ?? '';
        if (!book.services.includes(name)) return [WARN(`Warning: NOT_ENABLED: ${name}`)];
        book.services = book.services.filter((s) => s !== name);
        return finish('success');
      }

      if (addPort) {
        const spec = addPort.split('=')[1] ?? '';
        const port = /^(\d{1,5})(?:-(\d{1,5}))?\/(tcp|udp)$/.exec(spec);
        const value = port ? Number(port[1]) : 0;
        const value2 = port?.[2] ? Number(port[2]) : value;
        if (!port || value < 1 || value > 65535 || value2 < 1 || value2 > 65535) {
          return [ERR(`Error: INVALID_PORT: ${spec}`)];
        }
        if (book.ports.includes(spec)) return [WARN(`Warning: ALREADY_ENABLED: ${spec}`)];
        book.ports.push(spec);
        book.ports.sort();
        return finish('success');
      }

      if (removePort) {
        const spec = removePort.split('=')[1] ?? '';
        if (!book.ports.includes(spec)) return [WARN(`Warning: NOT_ENABLED: ${spec}`)];
        book.ports = book.ports.filter((p) => p !== spec);
        return finish('success');
      }

      const query = args.find((a) => a.startsWith('--query-'));
      if (query) {
        const [key, value] = query.replace(/^--query-/, '').split('=');
        const hit =
          key === 'service'
            ? book.services.includes(value)
            : key === 'port'
              ? book.ports.includes(value)
              : false;
        return [hit ? OK('yes') : WARN('no')];
      }

      return [
        DIM(`未实现的参数：${args.join(' ')}`),
        DIM('这一关支持 --state / --list-all / --add-service / --add-port / --remove-* / --reload / --permanent。'),
      ];
    },
  },
  objectives: [
    {
      id: 'http',
      label: '把 http 写入永久配置',
      hint: 'firewall-cmd --add-service=http --permanent',
      test: (s) => s.permanent.services.includes('http'),
    },
    {
      id: 'port',
      label: '把 8080/tcp 写入永久配置',
      hint: 'firewall-cmd --add-port=8080/tcp --permanent',
      test: (s) => s.permanent.ports.includes('8080/tcp'),
    },
    {
      id: 'reload',
      label: '让永久配置在运行时生效',
      hint: 'firewall-cmd --reload，然后 firewall-cmd --list-all 确认',
      test: (s) =>
        s.reloads > 0 &&
        s.runtime.services.includes('http') &&
        s.runtime.ports.includes('8080/tcp'),
    },
  ],
};

/* ---------- 权限 ---------- */

function triad(bits, special, kind) {
  const r = bits & 4 ? 'r' : '-';
  const w = bits & 2 ? 'w' : '-';
  let x = bits & 1 ? 'x' : '-';
  if (kind === 'group' && special) x = bits & 1 ? 's' : 'S';
  if (kind === 'other' && special) x = bits & 1 ? 't' : 'T';
  return r + w + x;
}

export function permString(entry) {
  const special = (entry.mode >> 9) & 7;
  return (
    (entry.type === 'dir' ? 'd' : '-') +
    triad((entry.mode >> 6) & 7) +
    triad((entry.mode >> 3) & 7, special & 2, 'group') +
    triad(entry.mode & 7, special & 1, 'other')
  );
}

function parentOf(path) {
  const clean = path.replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx <= 0 ? '/' : clean.slice(0, idx);
}

function baseName(path) {
  const clean = path.replace(/\/+$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1) || '/';
}

function applySymbolic(mode, spec) {
  const m = /^([ugoa]*)([+\-=])([rwxst]+)$/.exec(spec);
  if (!m) return null;
  const who = m[1] || 'a';
  const op = m[2];
  const perms = m[3];
  const classes = [];
  if (who.includes('u') || who.includes('a')) classes.push({ shift: 6, groupBit: 0, otherBit: 0 });
  if (who.includes('g') || who.includes('a')) classes.push({ shift: 3, groupBit: 0o2000, otherBit: 0 });
  if (who.includes('o') || who.includes('a')) classes.push({ shift: 0, groupBit: 0, otherBit: 0o1000 });

  let next = mode;
  for (const cls of classes) {
    // rwx 三个位要按 class 左移；s / t 是独立位，直接并进去。
    const rwx = perms.replace(/[st]/g, '');
    let bits = 0;
    for (const ch of rwx) {
      if (ch === 'r') bits |= 4;
      else if (ch === 'w') bits |= 2;
      else if (ch === 'x') bits |= 1;
    }
    const special = cls.shift === 3 ? (perms.includes('s') ? 0o2000 : 0) : cls.shift === 0 && perms.includes('t') ? 0o1000 : 0;
    const value = (bits << cls.shift) | special;

    if (op === '+') {
      next |= value;
    } else if (op === '-') {
      next &= ~value;
    } else {
      const clearMask = (7 << cls.shift) | (cls.shift === 3 ? 0o2000 : cls.shift === 0 ? 0o1000 : 0);
      next = (next & ~clearMask) | value;
    }
  }
  return next;
}

const PERM_LEVEL = {
  id: 'permissions',
  index: '03',
  title: '共享目录',
  kicker: '权限',
  article: '2026-09-21-linux-permission-model',
  articleTitle: 'Linux 权限模型一次讲透：基本权限 / SUID·SGID·Sticky / umask / ACL',
  prompt: 'root@lab:~#',
  intro: [
    DIM('# 实验台 03 · 共享目录'),
    L('/srv/share 现在是 root:root 755。dev 组成员能进能看，但写不进去；'),
    L('就算写进去，新文件也会落在 root 组，别的成员改不了。'),
    DIM('# 目标：组内可写、新文件自动归 dev、谁也不能删别人的文件。'),
    DIM('# 输入 help 看命令，hint 看下一步。'),
    '',
  ],
  help: [
    ['ls -l /srv/share', '查看目录内容'],
    ['ls -ld /srv/share', '查看目录本身的权限'],
    ['chgrp <组> <路径>', '修改属组'],
    ['chown <用户>[:<组>] <路径>', '修改属主 / 属组'],
    ['chmod <模式> <路径>', '修改权限，如 2775、3775、g+s'],
    ['touch <路径>', '新建空文件（用来验证继承）'],
    ['rm <路径>', '删除文件（重建时用）'],
    ['id <用户>', '查看用户所属组'],
    ['find / -perm -4000 -type f', '找出 SUID 程序'],
    ['clear / help / hint', '清屏 / 帮助 / 提示'],
  ],
  makeState: () => ({
    files: {
      '/srv/share': { type: 'dir', owner: 'root', group: 'root', mode: 0o755 },
      '/srv/share/alice.txt': { type: 'file', owner: 'alice', group: 'dev', mode: 0o644 },
      '/srv/share/bob.txt': { type: 'file', owner: 'bob', group: 'dev', mode: 0o644 },
    },
    users: { root: 'root', alice: 'dev', bob: 'dev', carol: 'ops' },
    groups: ['root', 'dev', 'ops'],
    suidFound: false,
  }),
  commands: {
    ls(state, args) {
      let long = false;
      let asFile = false;
      const paths = [];
      for (const a of args) {
        if (a.startsWith('-') && a.length > 1) {
          if (a.includes('l')) long = true;
          if (a.includes('d')) asFile = true;
        } else {
          paths.push(a);
        }
      }
      if (!paths.length) paths.push('/root');
      const out = [];
      const row = (entry, path, display = baseName(path)) => {
        const size = entry.type === 'dir' ? 4096 : 64;
        return `${permString(entry)} ${entry.type === 'dir' ? 2 : 1} ${pad(entry.owner, 7)} ${pad(
          entry.group,
          7,
        )} ${String(size).padStart(5)} Oct 26 14:21 ${display}`;
      };
      for (const path of paths) {
        const entry = state.files[path];
        if (!entry) {
          out.push(ERR(`ls: cannot access '${path}': No such file or directory`));
          continue;
        }
        if (entry.type === 'file' || asFile) {
          if (long) out.push(L(row(entry, path, path)));
          else out.push(L(baseName(path)));
          continue;
        }
        const children = Object.keys(state.files)
          .filter((key) => parentOf(key) === path.replace(/\/+$/, ''))
          .sort();
        out.push(L(`total ${children.length * 4}`));
        for (const child of children) {
          if (long) out.push(L(row(state.files[child], child)));
          else out.push(L(baseName(child)));
        }
      }
      return out;
    },

    chgrp(state, args) {
      const [group, path] = args.filter((a) => !a.startsWith('-'));
      if (!group || !path) return [DIM('用法：chgrp dev /srv/share')];
      if (!state.groups.includes(group)) return [ERR(`chgrp: invalid group: '${group}'`)];
      const entry = state.files[path];
      if (!entry) return [ERR(`chgrp: cannot access '${path}': No such file or directory`)];
      entry.group = group;
      return [];
    },

    chown(state, args) {
      const [spec, path] = args.filter((a) => !a.startsWith('-'));
      if (!spec || !path) return [DIM('用法：chown root:dev /srv/share')];
      const entry = state.files[path];
      if (!entry) return [ERR(`chown: cannot access '${path}': No such file or directory`)];
      const [owner, group] = spec.split(':');
      if (owner && !state.users[owner]) return [ERR(`chown: invalid user: '${owner}'`)];
      if (group && !state.groups.includes(group)) return [ERR(`chown: invalid group: '${group}'`)];
      if (owner) entry.owner = owner;
      if (group) entry.group = group;
      return [];
    },

    chmod(state, args) {
      const positional = args.filter((a) => !a.startsWith('-') || /^-[rwxst]+$/.test(a));
      const path = positional.pop();
      const modeArg = positional.pop();
      if (!path || !modeArg) return [DIM('用法：chmod 3775 /srv/share')];
      const entry = state.files[path];
      if (!entry) return [ERR(`chmod: cannot access '${path}': No such file or directory`)];
      if (/^[0-7]{3,4}$/.test(modeArg)) {
        entry.mode = parseInt(modeArg, 8);
        return [];
      }
      const next = applySymbolic(entry.mode, modeArg);
      if (next === null) return [ERR(`chmod: invalid mode: '${modeArg}'`)];
      entry.mode = next;
      return [];
    },

    touch(state, args) {
      const paths = args.filter((a) => !a.startsWith('-'));
      if (!paths.length) return [DIM('用法：touch /srv/share/report.txt')];
      const out = [];
      for (const path of paths) {
        if (state.files[path]) continue;
        const parent = state.files[parentOf(path)];
        if (!parent || parent.type !== 'dir') {
          out.push(ERR(`touch: cannot touch '${path}': No such file or directory`));
          continue;
        }
        state.files[path] = {
          type: 'file',
          owner: 'root',
          group: parent.mode & 0o2000 ? parent.group : 'root',
          mode: 0o644,
        };
      }
      return out;
    },

    rm(state, args) {
      const force = args.includes('-f');
      const paths = args.filter((a) => !a.startsWith('-'));
      const out = [];
      for (const path of paths) {
        const entry = state.files[path];
        if (!entry) {
          if (!force) out.push(ERR(`rm: cannot remove '${path}': No such file or directory`));
          continue;
        }
        if (entry.type === 'dir') {
          out.push(ERR(`rm: cannot remove '${path}': Is a directory`));
          continue;
        }
        delete state.files[path];
      }
      return out;
    },

    id(state, args) {
      const user = args[0] ?? 'root';
      const group = state.users[user];
      if (!group) return [ERR(`id: '${user}': no such user`)];
      const uid = user === 'root' ? 0 : 1000 + Object.keys(state.users).indexOf(user);
      return [L(`uid=${uid}(${user}) gid=${uid}(${group}) groups=${uid}(${group})`)];
    },

    groups(state, args) {
      const user = args[0] ?? 'root';
      const group = state.users[user];
      if (!group) return [ERR(`groups: '${user}': no such user`)];
      return [L(`${user} : ${group}`)];
    },

    find(state, args) {
      const joined = args.join(' ');
      if (/-(perm)\s+-?4000/.test(joined)) {
        state.suidFound = true;
        return [
          '/usr/bin/passwd',
          '/usr/bin/su',
          '/usr/bin/sudo',
          '/usr/bin/chsh',
          '/usr/bin/newgrp',
          '/usr/bin/gpasswd',
          '/usr/bin/mount',
          '/usr/bin/umount',
          '/usr/libexec/openssh/ssh-keysign',
        ].map((p) => L(p));
      }
      return [
        DIM('这一关只实现了 `find / -perm -4000 -type f` 这一种查找。'),
      ];
    },

    stat(state, args) {
      const path = args.filter((a) => !a.startsWith('-'))[0];
      const entry = state.files[path];
      if (!entry) return [ERR(`stat: cannot statx '${path}': No such file or directory`)];
      return [
        L(`  File: ${path}`),
        L(`  Size: ${entry.type === 'dir' ? 4096 : 64}\t\t${entry.type}`),
        L(`Access: (${entry.mode.toString(8).padStart(4, '0')}/${permString(entry)})  Uid: (0/${entry.owner})   Gid: (0/${entry.group})`),
      ];
    },
  },
  objectives: [
    {
      id: 'group',
      label: '把 /srv/share 的属组改为 dev',
      hint: 'chgrp dev /srv/share',
      test: (s) => s.files['/srv/share']?.group === 'dev',
    },
    {
      id: 'mode',
      label: '设置 setgid + 组写 + sticky',
      hint: 'chmod 3775 /srv/share（3 = setgid + sticky，775 = 组内可写）',
      test: (s) => {
        const m = s.files['/srv/share']?.mode ?? 0;
        return (m & 0o2000) !== 0 && (m & 0o1000) !== 0 && (m & 0o070) === 0o070;
      },
    },
    {
      id: 'inherit',
      label: '新建 report.txt，确认属组自动是 dev',
      hint: 'touch /srv/share/report.txt，然后 ls -l /srv/share；如果之前已经建过，先 rm 再重建。',
      test: (s) => s.files['/srv/share/report.txt']?.group === 'dev',
    },
    {
      id: 'suid',
      label: '找出系统里的 SUID 程序',
      hint: 'find / -perm -4000 -type f',
      test: (s) => s.suidFound,
    },
  ],
};

/* ---------- 对外接口 ---------- */

export const levels = [LVM_LEVEL, FIREWALL_LEVEL, PERM_LEVEL];

export const levelById = new Map(levels.map((level) => [level.id, level]));

export function createSession(level) {
  return {
    level,
    state: level.makeState(),
    history: [],
  };
}

export function objectiveStatus(session) {
  return session.level.objectives.map((objective) => ({
    id: objective.id,
    label: objective.label,
    hint: objective.hint,
    done: Boolean(objective.test(session.state, session)),
  }));
}

function helpLines(level) {
  const out = [DIM(`# ${level.index} ${level.kicker} · ${level.title}`)];
  for (const [cmd, desc] of level.help) {
    out.push(L(`  ${pad(cmd, 32)} ${desc}`));
  }
  return out;
}

function hintLines(session) {
  const status = objectiveStatus(session);
  const index = status.findIndex((item) => !item.done);
  if (index < 0) {
    return [OK('这一关已经完成。'), DIM('可以换一关，或者点「重置本关」再走一遍。')];
  }
  return [
    DIM(`目标 ${index + 1}/${status.length}：${status[index].label}`),
    L(`  ${status[index].hint}`),
  ];
}

export function execute(session, raw) {
  const input = String(raw ?? '').trim();
  if (!input) return { lines: [] };

  session.history.push(input);
  if (session.history.length > 120) session.history.shift();

  const [cmd, ...args] = tokenize(input);
  if (!cmd) return { lines: [] };
  if (cmd === 'clear') return { lines: [], clear: true };
  if (cmd === 'help' || cmd === '?') return { lines: helpLines(session.level) };
  if (cmd === 'hint') return { lines: hintLines(session) };

  const handler = session.level.commands[cmd];
  const fallback = handler ? null : builtin(session, cmd, args);
  if (!handler && !fallback) {
    return {
      lines: [ERR(`${cmd}: command not found`), DIM('输入 help 查看本关实现的命令。')],
    };
  }

  let output;
  try {
    output = handler ? handler(session.state, args, session) : fallback;
  } catch (error) {
    return { lines: [ERR(`实验台内部错误：${error.message}`)] };
  }

  return {
    lines: (output ?? []).map((item) => (typeof item === 'string' ? L(item) : item)),
  };
}
