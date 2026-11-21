#!/usr/bin/python3 -I
"""Read-only probe, run AS the user under test: connect(2) to a unix socket and close. Never sends anything unless --healthz.
usage: connect-probe.py <socket path> [--healthz]   prints CONNECTED / DENIED(errno) / OTHER, and with --healthz the first response line"""
import socket, sys
p = sys.argv[1]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(3)
try:
    s.connect(p)
    if '--healthz' in sys.argv:
        s.sendall(b'GET /healthz HTTP/1.0\r\nHost: signer\r\n\r\n')
        data = b''
        while True:
            try:
                c = s.recv(4096)
            except socket.timeout:
                break
            if not c: break
            data += c
        print('CONNECTED', p, '|', data.split(b'\r\n', 1)[0].decode('latin1'), '|', data.split(b'\r\n\r\n', 1)[-1][:60].decode('latin1'))
    else:
        print('CONNECTED', p)
except PermissionError as e:
    print('DENIED', p, e.errno)
except FileNotFoundError as e:
    print('NOENT', p, e.errno)
except Exception as e:
    print('OTHER', p, type(e).__name__, e)
finally:
    s.close()
