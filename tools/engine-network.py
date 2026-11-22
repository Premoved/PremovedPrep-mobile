#!/usr/bin/env python3
"""Two small jobs for .github/workflows/engines.yml, on 64-bit ELF files (the Android engines).

  engine-network.py OFFICIAL BUILT OUT   OUT = BUILT followed by the network the OFFICIAL Lc0 carries
                                         (everything after the ELF image: the embedded weights).
  engine-network.py --check FILE...      Fails unless every loaded segment allows 16 KB pages, so the
                                         binary runs on devices with 4 KB and with 16 KB pages.
"""

import struct
import sys

PAGE = 16 * 1024
PT_LOAD = 1


def elf_end(data):
    if data[:4] != b'\x7fELF' or data[4] != 2:
        raise SystemExit('not a 64-bit ELF file')
    shoff = struct.unpack_from('<Q', data, 0x28)[0]
    phoff = struct.unpack_from('<Q', data, 0x20)[0]
    phentsize, phnum, shentsize, shnum = struct.unpack_from('<HHHH', data, 0x36)
    end = max(shoff + shentsize * shnum, phoff + phentsize * phnum)
    for i in range(phnum):
        _, _, offset, _, _, filesz, _, _ = struct.unpack_from('<IIQQQQQQ', data, phoff + i * phentsize)
        end = max(end, offset + filesz)
    return end


def append_network(official, built, out):
    with open(official, 'rb') as f:
        data = f.read()
    network = data[elf_end(data):]
    if not network.startswith(b'\x1f\x8b'):
        raise SystemExit(f'{official}: no gzip network after the ELF image')
    with open(built, 'rb') as f:
        binary = f.read()
    with open(out, 'wb') as f:
        f.write(binary)
        f.write(network)
    print(f'{out}: {len(binary)} bytes of engine and {len(network)} bytes of network')


def check(paths):
    failed = False
    for path in paths:
        with open(path, 'rb') as f:
            data = f.read()
        phoff = struct.unpack_from('<Q', data, 0x20)[0]
        phentsize, phnum = struct.unpack_from('<HH', data, 0x36)
        for i in range(phnum):
            kind, _, offset, vaddr, _, _, _, align = struct.unpack_from('<IIQQQQQQ', data, phoff + i * phentsize)
            if kind != PT_LOAD:
                continue
            if align < PAGE or offset % PAGE != vaddr % PAGE:
                print(f'{path}: a segment is aligned to {align} bytes, not 16 KB')
                failed = True
                break
        else:
            print(f'{path}: 16 KB aligned')
    if failed:
        sys.exit(1)


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == '--check':
        check(sys.argv[2:])
    elif len(sys.argv) == 4:
        append_network(*sys.argv[1:])
    else:
        raise SystemExit(__doc__)
