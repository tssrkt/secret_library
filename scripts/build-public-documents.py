"""Generate checked-in public content directly from the authoritative DOCX files."""
from pathlib import Path
from zipfile import ZipFile
import xml.etree.ElementTree as ET
import html
import re
import json
import argparse

ROOT = Path(__file__).resolve().parents[1]
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
CONTACT = 'сообщите владельцу «Тайной Библиотеки»'


def document(name):
    with ZipFile(ROOT / 'temp' / name) as archive:
        body = ET.fromstring(archive.read('word/document.xml')).find(W + 'body')
        relationships = ET.fromstring(archive.read('word/_rels/document.xml.rels'))
        links = {item.attrib['Id']: item.attrib['Target'] for item in relationships}
    if any(child.tag not in (W + 'p', W + 'sectPr') for child in body):
        raise ValueError('Unsupported document structure: extend converter before publishing')
    return list(body.findall(W + 'p')), links


def text_of(element):
    return ''.join(node.text or '' if node.tag == W + 't' else '\n' if node.tag in (W + 'br', W + 'cr') else '\t'
                   for node in element.iter() if node.tag in (W + 't', W + 'br', W + 'cr', W + 'tab'))


def inline(element, links):
    output = ''
    for child in element:
        if child.tag == W + 'r':
            content = html.escape(text_of(child)).replace('\n', '<br>')
            if CONTACT in content:
                content = content.replace(CONTACT, f'<a href="https://t.me/ptica_govorun_bot" target="_blank" rel="noopener noreferrer">{CONTACT}</a>')
            props = child.find(W + 'rPr')
            if props is not None:
                for name, tag in [('b', 'strong'), ('i', 'em'), ('u', 'u')]:
                    prop = props.find(W + name)
                    if prop is not None and prop.get(W + 'val') not in ('0', 'false', 'none'):
                        content = f'<{tag}>{content}</{tag}>'
            output += content
        elif child.tag == W + 'hyperlink':
            url = links.get(child.get(R + 'id'), '')
            if not url.startswith(('https://', 'http://', 'mailto:')):
                raise ValueError('Unsupported hyperlink')
            output += f'<a href="{html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer">{inline(child, links)}</a>'
    return output


def generate():
    paragraphs, links = document('info.docx')
    blocks = []
    in_list = False
    for position, paragraph in enumerate(paragraphs):
        text = text_of(paragraph)
        numbered = bool(re.match(r'^\d+\.\s', text))
        if numbered and not in_list:
            blocks.append('<ol class="source-numbering">')
        if in_list and not numbered:
            blocks.append('</ol>')
        in_list = numbered
        style = paragraph.find(f'{W}pPr/{W}pStyle')
        heading = re.search(r'heading\s*([1-6])', style.get(W + 'val', ''), re.I) if style is not None else None
        tag = 'li' if numbered else 'h' + heading[1] if heading else 'p'
        spacing = paragraph.find(f'{W}pPr/{W}spacing')
        css = []
        if spacing is not None:
            for attr, prop in [('before', 'margin-top'), ('after', 'margin-bottom')]:
                if spacing.get(W + attr):
                    css.append(f'{prop}:{int(spacing.get(W + attr)) / 20:g}pt')
            if spacing.get(W + 'lineRule') == 'auto' and spacing.get(W + 'line'):
                css.append(f'line-height:{int(spacing.get(W + "line")) / 240:g}')
        blocks.append(f'<{tag} data-docx-paragraph="{position}" style="{";".join(css)}">{inline(paragraph, links) or "<br>"}</{tag}>')
    if in_list:
        blocks.append('</ol>')
    page = '''<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Инструкция — Тайная Библиотека</title>
  <link rel="stylesheet" href="./css/styles.css">
  <link rel="stylesheet" href="./css/info.css">
</head>
<body class="info-page">
  <main class="app-shell">
    <header class="info-header"><a href="./index.html">Тайная Библиотека</a></header>
    <article class="info-document" aria-label="Инструкция">
''' + '\n'.join(blocks) + '''
    </article>
  </main>
</body>
</html>
'''
    email, _ = document('email.docx')
    texts = [text_of(p) for p in email]
    start = texts.index('Текст письма:') + 1
    template = '\n\n'.join(texts[start:])
    return {ROOT / 'info.html': page, ROOT / 'functions' / 'invitation-template.json': json.dumps({
        'subject': 'Приглашение в «Тайную Библиотеку»', 'text': template,
    }, ensure_ascii=False, indent=2) + '\n'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for path, content in generate().items():
        if args.check:
            assert path.read_text(encoding='utf-8') == content, f'Regenerate {path.name}'
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding='utf-8', newline='\n')
