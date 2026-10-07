#!/usr/bin/env python3
"""Generate a minimal RAR 4.0 archive with STORED (uncompressed) entries.
Used as a test fixture for repo2text RAR support. No rar binary needed.

Format reference: RAR 4.x block layout.
"""
import struct, zlib, sys, os

def crc32(data):
    return zlib.crc32(data) & 0xFFFFFFFF

def dos_time():
    return struct.pack('<I', 0)

def block(crc_body):
    """Prepend HEAD_CRC = low 16 bits of CRC32 of body (RAR 4.x rule)."""
    return struct.pack('<H', crc32(crc_body) & 0xFFFF) + crc_body

def main_head():
    body = struct.pack('<BHH', 0x73, 0x0000, 7)
    return block(body)

def file_head(name: bytes, data: bytes, flags=0x0000):
    pack_size = len(data)
    unp_size = len(data)
    name_size = len(name)
    head_size = 32 + name_size  # 2+1+2+2 + 4+4+1+4+4+1+1+2+4 + name
    body = struct.pack('<BHH', 0x74, flags, head_size)
    body += struct.pack('<II', pack_size, unp_size)
    body += struct.pack('<B', 0x03)          # HOST_OS = Unix
    body += struct.pack('<I', crc32(data))   # FILE_CRC
    body += dos_time()                        # FTIME
    body += struct.pack('<B', 29)             # UNP_VER = 2.9
    body += struct.pack('<B', 0x30)           # METHOD = storing
    body += struct.pack('<H', name_size)
    body += struct.pack('<I', 0o100644 << 16) # ATTR
    body += name
    assert len(body) == head_size - 2
    return block(body) + data

def end_head():
    body = struct.pack('<BHH', 0x7B, 0x0000, 7)
    return block(body)

def main():
    out = bytearray()
    out += bytes([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00])  # Rar!\x1a\x07\x00
    out += main_head()
    files = [
        (b'README.md', b'# Sample RAR\n\nhello-world\n'),
        (b'src/hello.js', b'function x() { return "hello-world"; }\n'),
        (b'src/app.ts', b'export const app = 1;\n'),
        (b'empty.txt', b''),
        (b'assets/logo.bin', bytes(range(256))),
        (b'secret.txt', b'top secret', 0x0004),  # encrypted flag, still stored
    ]
    for entry in files:
        if len(entry) == 3:
            name, data, flags = entry
        else:
            name, data = entry
            flags = 0x0000
        out += file_head(name, data, flags)
    out += end_head()
    dest = sys.argv[1] if len(sys.argv) > 1 else 'sample.rar'
    with open(dest, 'wb') as f:
        f.write(bytes(out))
    print('wrote', dest, len(out), 'bytes')

if __name__ == '__main__':
    main()
