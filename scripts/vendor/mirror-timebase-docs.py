# Mirror docs.timebase.com articles (from its search-index.json) to Markdown + local assets.
# Needs beautifulsoup4. Run from a folder outside the download dir, with Windows paths (MSYS /c/... is not converted):
#   python -P scripts/vendor/mirror-timebase-docs.py <raw_cache_dir> docs/vendor/timebase <YYYY-MM-DD>
# Delete docs/vendor/timebase first for a clean refresh; raw_cache_dir keeps the fetched HTML.
import json, os, posixpath, re, sys, urllib.request
from bs4 import BeautifulSoup, NavigableString, Tag

BASE = 'https://docs.timebase.com/'
raw, out, fetched = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(raw, exist_ok=True)

def get(url, dest):
    if not os.path.exists(dest):
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, 'wb') as f:
            f.write(r.read())
    return open(dest, encoding='utf-8').read()

index = json.loads(get(BASE + 'search-index.json', os.path.join(raw, 'search-index.json')))
articles = {('/' + a['url']).rstrip('/') + '/': a for a in index}

# The repo lives under a ~170-char Windows path (MAX_PATH 260), so segments are capped.
def md_path(page):  # '/timebase-components/b/c/' -> 'components/b/c.md'
    segs = page.strip('/').replace('timebase-components', 'components', 1).split('/')
    return '/'.join(s[:48].rstrip('-') for s in segs) + '.md'

def asset_path(path):  # 'assets/<dir>/<file.ext>' -> 'assets/<dir32>/<file40>.ext'
    _, d, f = path.split('/', 2)
    stem, ext = posixpath.splitext(f.replace('/', '-'))
    return f'assets/{d[:32].rstrip("-")}/{stem[:40].rstrip("-")}{ext}'

assert len({md_path(p) for p in articles}) == len(articles), 'md_path collision'

def asset(href, page):  # download a docs asset next to the Markdown, return its relative path
    src = posixpath.normpath(posixpath.join(page, href)).lstrip('/')
    path = asset_path(src)
    dest = os.path.join(out, *path.split('/'))
    if not os.path.exists(dest):
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        req = urllib.request.Request(BASE + src, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, 'wb') as f:
            f.write(r.read())
    return posixpath.relpath(path, posixpath.dirname(md_path(page)) or '.')

def link(href, page):
    if href.startswith(('http://', 'https://', 'mailto:')):
        return href
    if href.startswith('#'):
        return href
    path, _, frag = href.partition('#')
    if '/assets/' in posixpath.join(page, path):
        return asset(path, page)
    target = posixpath.normpath(posixpath.join(page, path)) + '/'
    target = '/' if target in ('./', '//') else target.replace('//', '/')
    here = posixpath.dirname(md_path(page))
    dest = md_path(target) if target in articles else 'INDEX.md'
    rel = posixpath.relpath(dest, here or '.')
    return rel + ('#' + frag if frag else '')

def inline(node, page):
    if isinstance(node, NavigableString):
        return re.sub(r'\s+', ' ', str(node))
    if not isinstance(node, Tag) or node.name in ('button', 'svg', 'script', 'style'):
        return ''
    if 'tb-anchor' in node.get('class', []):
        return ''
    inner = ''.join(inline(c, page) for c in node.children)
    n = node.name
    if n in ('strong', 'b'):
        return f'**{inner.strip()}**' if inner.strip() else ''
    if n in ('em', 'i'):
        return f'*{inner.strip()}*' if inner.strip() else ''
    if n == 'code':
        t = node.get_text()
        return f'`` {t} ``' if '`' in t else f'`{t}`'
    if n == 'a':
        h = node.get('href')
        return f'[{inner.strip()}]({link(h, page)})' if h else inner
    if n == 'br':
        return '  \n'
    if n == 'img':
        return f"![{node.get('alt', '')}]({asset(node['src'], page)})" if node.get('src') else ''
    return inner

def table(t, page):
    rows = [[inline(c, page).strip().replace('|', '\\|') for c in tr.find_all(['th', 'td'])] for tr in t.find_all('tr')]
    rows = [r for r in rows if r]
    if not rows:
        return ''
    w = max(len(r) for r in rows)
    rows = [r + [''] * (w - len(r)) for r in rows]
    lines = ['| ' + ' | '.join(rows[0]) + ' |', '|' + '---|' * w]
    lines += ['| ' + ' | '.join(r) + ' |' for r in rows[1:]]
    return '\n'.join(lines)

def block(node, page, depth=0):
    if isinstance(node, NavigableString):
        t = str(node).strip()
        return [t] if t else []
    if not isinstance(node, Tag) or node.name in ('button', 'svg', 'script', 'style'):
        return []
    n, cls = node.name, node.get('class', [])
    if n in ('h1', 'h2', 'h3', 'h4', 'h5'):
        return ['#' * int(n[1]) + ' ' + inline(node, page).strip()]
    if n == 'p':
        t = inline(node, page).strip()
        return [t] if t else []
    if n == 'pre':
        code = node.find('code') or node
        lang = next((c[9:] for c in code.get('class', []) if c.startswith('language-')), '')
        body = code.get_text().rstrip('\n')
        fence = '````' if '```' in body else '```'
        return [f'{fence}{lang}\n{body}\n{fence}']
    if n == 'table':
        return [table(node, page)]
    if n in ('ul', 'ol'):
        items = []
        for i, li in enumerate(node.find_all('li', recursive=False), 1):
            mark = f'{i}.' if n == 'ol' else '-'
            head, rest = [], []
            for c in li.children:
                if isinstance(c, Tag) and c.name in ('ul', 'ol', 'pre', 'table', 'div'):
                    rest += block(c, page, depth + 1)
                else:
                    head.append(inline(c, page))
            pad = '   ' * depth
            items.append(f"{pad}{mark} {''.join(head).strip()}")
            for r in rest:
                items.append('\n'.join(('   ' * (depth + 1)) + l if l else l for l in r.split('\n')))
        return ['\n'.join(items)]
    if n == 'blockquote' or 'tb-callout' in cls:
        kick = node.find(class_='kick')
        label = kick.get_text(strip=True) if kick else ''
        if kick:
            kick.extract()
        parts = [p for c in node.children for p in block(c, page, depth)]
        text = '\n\n'.join(parts)
        if label:
            text = f'**{label}:** ' + text
        return ['\n'.join('> ' + l if l else '>' for l in text.split('\n'))]
    if n == 'img':
        return [inline(node, page)]
    return [p for c in node.children for p in block(c, page, depth)]

rows = []
for page, a in sorted(articles.items()):
    html = get(BASE + page.lstrip('/'), os.path.join(raw, page.strip('/').replace('/', '__') + '.html'))
    soup = BeautifulSoup(html, 'html.parser')
    art = soup.find(id='articleCol')
    title = art.find('h1').get_text(strip=True)
    deck = art.find(class_='tb-deck')
    meta = art.find(class_='tb-metarow')
    updated = meta.find('span').get_text(strip=True).replace('Updated ', '') if meta else ''
    parts = [f'# {title}', '']
    if deck:
        parts += [f'*{inline(deck, page).strip()}*', '']
    parts += [f"> Source: {BASE}{page.lstrip('/')} · {a['product']} · {a['type']} · updated {updated} · mirrored {fetched}", '']
    body = art.find(id='bodyContent')
    parts.append('\n\n'.join(p for p in block(body, page) if p.strip()))
    dest = os.path.join(out, *md_path(page).split('/'))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'w', encoding='utf-8', newline='') as f:
        f.write('\n'.join(parts).rstrip() + '\n')
    rows.append((a['sectionLabel'], a['product'], title, md_path(page), a['type'], a.get('summary', ''), updated))

with open(os.path.join(out, 'INDEX.md'), 'w', encoding='utf-8', newline='') as f:
    f.write(f'# Timebase 2.0 documentation index\n\nMirrored from {BASE} on {fetched}. {len(rows)} articles.\n')
    for prod in sorted({r[1] for r in rows}):
        f.write(f'\n## {prod}\n\n| Article | Type | Answers | Updated |\n|---|---|---|---|\n')
        for r in sorted(x for x in rows if x[1] == prod):
            f.write(f"| [{r[2]}]({r[3]}) | {r[4]} | {r[5].replace('|', '/')} | {r[6]} |\n")
print(len(rows), 'articles')
