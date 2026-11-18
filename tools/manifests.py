#!/usr/bin/env python3
"""Render fixed script URLs from hyrz-local.plugin. No network access."""
import argparse
import re
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

TEMPLATE = Path(__file__).resolve().parents[1] / 'hyrz-local.plugin'
SCRIPT = re.compile(r'(?<=then script\(")(hyrz-(?:sniff|sign)\.js)(?=")')


def base_url(value):
    # Only URL characters safe inside a fixed Loon string; encode other path bytes.
    if not re.fullmatch(r'https?://[A-Za-z0-9.:\[\]-]+(?:/(?:[A-Za-z0-9._~@/-]|%[0-9A-Fa-f]{2})*)?', value):
        raise ValueError('expected an absolute directory URL without credentials, query or fragment')
    url = urlsplit(value)
    if not url.hostname or url.netloc.endswith(':') or url.port == 0:
        raise ValueError('invalid host or port')
    if url.scheme == 'http' and url.netloc != '127.0.0.1:18916':
        raise ValueError('use HTTPS (HTTP allowed only for 127.0.0.1:18916)')
    return value.rstrip('/')


def render(base):
    prefix = base_url(base) + '/'
    return SCRIPT.sub(lambda m: prefix + m[0] + '?v=9.16.2',
                      TEMPLATE.read_text(encoding='utf-8'))


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--base-url', required=True, help='URL of the directory serving both scripts and plugin')
    cli.add_argument('-o', '--output', type=Path, help='new .plugin file; otherwise write manifest to stdout')
    args = cli.parse_args()
    try:
        text = render(args.base_url)
        if args.output is None:
            sys.stdout.buffer.write(text.encode('utf-8'))
            return
        if args.output.suffix != '.plugin':
            raise ValueError('output must end in .plugin')
        with args.output.open('x', encoding='utf-8', newline='\n') as out:
            out.write(text)
        url = args.base_url.rstrip('/') + '/' + quote(args.output.name, safe='')
        print('loon://import?plugin=' + quote(url, safe=''))
    except (OSError, ValueError) as e:
        cli.exit(2, f'{cli.prog}: {e}\n')


if __name__ == '__main__':
    main()
