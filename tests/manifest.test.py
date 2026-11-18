"""Offline manifest contract: python3 -B tests/manifest.test.py"""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
BASES = {
    'hyrz-checkin.plugin': 'https://raw.githubusercontent.com/bzmshang/hyrz-checkin/main',
    'hyrz-checkin-jsdelivr.plugin': 'https://cdn.jsdelivr.net/gh/bzmshang/hyrz-checkin@main',
    'hyrz-localhost.plugin': 'http://127.0.0.1:18916',
}
LOCAL = (ROOT / 'hyrz-local.plugin').read_text(encoding='utf-8')
RULES = LOCAL.split('[Script]\n')[1].split('\n[MitM]')[0].splitlines()
ARGS = '{${signFlow},${claimGift},${autoTasks},${catchup},${uploadLog},${logTopic}}'


def build(base, *options):
    return subprocess.run([sys.executable, '-B', str(ROOT / 'tools/manifests.py'),
                           '--base-url', base, *options], capture_output=True, text=True)


class Manifests(unittest.TestCase):
    def test_variants(self):
        for name, base in BASES.items():
            expected = LOCAL.replace('then script("hyrz-', f'then script("{base}/hyrz-')
            self.assertEqual((ROOT / name).read_text(encoding='utf-8'), expected, name)
            self.assertEqual(build(base + '/').stdout, expected, name)

    def test_scope_and_defaults(self):
        self.assertEqual(re.findall(r'^\[(.+)\]$', LOCAL, re.M), ['Argument', 'Script', 'MitM'])
        self.assertIn('#!loon_version = 3.5.1(983)\n', LOCAL)
        self.assertEqual(LOCAL.split('[MitM]\n')[1].strip(), 'hostname = x8m8.ams.game.qq.com, ulinkact.game.qq.com')
        for k in ('claimGift', 'autoTasks', 'catchup', 'uploadLog'):
            self.assertIn(f'\n{k} = switch,false,type=boolean,', LOCAL)
        self.assertIn('\nlogTopic = input,"",type=string,', LOCAL)
        self.assertIn('\nsignFlow = input,"1083576",type=string,', LOCAL)

    def test_capture(self):
        hosts = ('x8m8.ams.game.qq.com', 'ulinkact.game.qq.com')
        paths = ('/ams/ame/amesvr', '/app/7335/99200e6deafa8a6a/index.php')
        for phase in ('request', 'response'):
            rule, = [s for s in RULES if s.startswith(phase + ' ')]
            guard, action = rule.split(' then ')
            self.assertTrue(guard.startswith(phase + ' if ${url} ~= /') and guard.endswith('/'))
            pattern = re.compile(guard.split(' ~= /')[1][:-1])
            self.assertTrue(action.startswith('script("hyrz-sniff.js", {${catchup}}) with '))
            self.assertIn('requires_body=true', action)
            for i, host in enumerate(hosts):
                prefix = 'https://' + host
                url = prefix + paths[i]
                for good in (url, url + '?a=b&c=1'):
                    self.assertIsNotNone(pattern.search(good), good)
                for bad in (url.replace('https:', 'http:'), url + '/', url + 'X',
                            prefix + paths[1-i], prefix + '/hyrz-panel-now',
                            prefix + '.invalid' + paths[i], 'https://other.invalid/?ref=' + url):
                    self.assertIsNone(pattern.search(bad), bad)

    def test_dispatch(self):
        expected = [('generic', '火影·' + name) for name in ('只读诊断', '手动签到', '手动补领', '看日志')]
        expected += [('cron ${cronTime}', '火影·每日签到')]
        expected += [(f'cron "5 {h} * * *"', f'火影·定时补领-{h}') for h in (12, 15, 18, 21, 23)]
        expected += [(f'cron "{m} * * * *"', '火影·待办检查') for m in (2, 12, 22, 32, 42, 52)]
        actual = []
        for rule in filter(None, RULES):
            if rule.startswith(('request ', 'response ')):
                continue
            trigger, options = rule.split(f' then script("hyrz-sign.js", {ARGS}) with ')
            tag, = re.findall(r'tag="([^"]+)"', options)
            self.assertEqual('enable=${catchup}' in options, trigger.startswith('cron "'))
            actual.append((trigger, tag))
        self.assertCountEqual(actual, expected)

    def test_private_build(self):
        base = 'https://nas.example.invalid:8443/loon/v9.16'
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'test.plugin'
            result = build(base, '-o', str(out))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'loon://import?plugin=' + quote(base + '/test.plugin', safe=''))
            self.assertEqual(out.read_text(encoding='utf-8'), LOCAL.replace('then script("hyrz-', f'then script("{base}/hyrz-'))
            self.assertNotEqual(build(base + '/other', '-o', str(out)).returncode, 0)
        for bad in ('./relative', 'http://nas.invalid', 'http://127.0.0.1:80', 'https://a:b@host',
                    'https://host/?token=bad', 'https://host/#bad', 'https://host/"\n'):
            self.assertNotEqual(build(bad).returncode, 0, bad)


if __name__ == '__main__':
    unittest.main()
