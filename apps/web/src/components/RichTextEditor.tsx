import { CKEditor } from '@ckeditor/ckeditor5-react';
import {
  ClassicEditor,
  // core
  Essentials, Paragraph, Undo, SelectAll, Autoformat, TextTransformation, PasteFromOffice, GeneralHtmlSupport,
  // text
  Heading, Bold, Italic, Underline, Strikethrough, Subscript, Superscript, Code, RemoveFormat,
  FontFamily, FontSize, FontColor, FontBackgroundColor, Highlight, Alignment,
  // structure
  List, ListProperties, TodoList, Indent, IndentBlock, BlockQuote, HorizontalLine, PageBreak, CodeBlock,
  // links & media
  Link, AutoLink, LinkImage, Bookmark,
  Image, ImageInsert, ImageInsertViaUrl, ImageUpload, ImageToolbar, ImageCaption, ImageStyle, ImageResize, ImageTextAlternative,
  Base64UploadAdapter, MediaEmbed,
  // tables
  Table, TableToolbar, TableProperties, TableCellProperties, TableColumnResize, TableCaption,
  // extras
  SpecialCharacters, SpecialCharactersEssentials, Emoji, Mention,
  FindAndReplace, SourceEditing, HtmlEmbed, ShowBlocks, WordCount, Fullscreen,
} from 'ckeditor5';
import 'ckeditor5/ckeditor5.css';

const PLUGINS = [
  Essentials, Paragraph, Undo, SelectAll, Autoformat, TextTransformation, PasteFromOffice, GeneralHtmlSupport,
  Heading, Bold, Italic, Underline, Strikethrough, Subscript, Superscript, Code, RemoveFormat,
  FontFamily, FontSize, FontColor, FontBackgroundColor, Highlight, Alignment,
  List, ListProperties, TodoList, Indent, IndentBlock, BlockQuote, HorizontalLine, PageBreak, CodeBlock,
  Link, AutoLink, LinkImage, Bookmark,
  Image, ImageInsert, ImageInsertViaUrl, ImageUpload, ImageToolbar, ImageCaption, ImageStyle, ImageResize, ImageTextAlternative,
  Base64UploadAdapter, MediaEmbed,
  Table, TableToolbar, TableProperties, TableCellProperties, TableColumnResize, TableCaption,
  SpecialCharacters, SpecialCharactersEssentials, Emoji, Mention,
  FindAndReplace, SourceEditing, HtmlEmbed, ShowBlocks, WordCount, Fullscreen,
];

const TOOLBAR = {
  shouldNotGroupWhenFull: true,
  items: [
    'undo', 'redo', '|',
    'findAndReplace', 'selectAll', '|',
    'heading', '|',
    'fontFamily', 'fontSize', 'fontColor', 'fontBackgroundColor', '|',
    'bold', 'italic', 'underline', 'strikethrough', 'subscript', 'superscript', 'code', 'removeFormat', '|',
    'highlight', 'alignment', '|',
    'bulletedList', 'numberedList', 'todoList', 'outdent', 'indent', '|',
    'link', 'bookmark', 'insertImage', 'mediaEmbed', 'insertTable', 'blockQuote', 'codeBlock', 'htmlEmbed', '|',
    'horizontalLine', 'pageBreak', 'specialCharacters', 'emoji', '|',
    'showBlocks', 'sourceEditing', 'fullscreen',
  ],
};

/**
 * CKEditor 5 wrapped for email bodies, with the full open-source feature set. Emits HTML.
 * Licensed under GPL — swap `licenseKey` for a commercial key if the studio
 * needs one (see https://ckeditor.com/pricing/).
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="rte">
      <CKEditor
        editor={ClassicEditor}
        data={value}
        config={{
          licenseKey: 'GPL',
          plugins: PLUGINS,
          toolbar: TOOLBAR,
          placeholder,
          fontFamily: { supportAllValues: true },
          fontSize: { options: [10, 12, 'default', 14, 16, 18, 20, 24, 28], supportAllValues: true },
          heading: {
            options: [
              { model: 'paragraph', title: 'Paragraph', class: 'ck-heading_paragraph' },
              { model: 'heading1', view: 'h1', title: 'Heading 1', class: 'ck-heading_heading1' },
              { model: 'heading2', view: 'h2', title: 'Heading 2', class: 'ck-heading_heading2' },
              { model: 'heading3', view: 'h3', title: 'Heading 3', class: 'ck-heading_heading3' },
              { model: 'heading4', view: 'h4', title: 'Heading 4', class: 'ck-heading_heading4' },
            ],
          },
          link: {
            addTargetToExternalLinks: true,
            defaultProtocol: 'https://',
            decorators: {
              openInNewTab: {
                mode: 'manual',
                label: 'Open in a new tab',
                attributes: { target: '_blank', rel: 'noopener noreferrer' },
              },
            },
          },
          list: { properties: { styles: true, startIndex: true, reversed: true } },
          image: {
            toolbar: [
              'imageTextAlternative', 'toggleImageCaption', '|',
              'imageStyle:inline', 'imageStyle:wrapText', 'imageStyle:breakText', '|',
              'resizeImage', 'linkImage',
            ],
            insert: { integrations: ['upload', 'url'] },
          },
          table: {
            contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells', 'tableProperties', 'tableCellProperties', 'toggleTableCaption'],
          },
          htmlSupport: {
            allow: [{ name: /.*/, attributes: true, classes: true, styles: true }],
          },
          fullscreen: { container: document.body },
        }}
        onReady={(editor) => {
          if (autoFocus) editor.editing.view.focus();
        }}
        onChange={(_e, editor) => onChange(editor.getData())}
      />
    </div>
  );
}

/** Convert stored draft text (plain or HTML) to HTML the editor can load. */
export function toEditorHtml(text: string): string {
  if (/<(p|br|div|ul|ol|h\d|blockquote|table|figure|hr)\b/i.test(text)) return text;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Convert editor HTML into plain text suitable for a Gmail compose link. */
export function htmlToPlainText(html: string): string {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out.push(node.textContent ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') { out.push('\n'); return; }
    if (tag === 'hr') { out.push('\n———\n\n'); return; }
    if (tag === 'img') { const alt = el.getAttribute('alt'); if (alt) out.push(`[${alt}]`); return; }
    if (tag === 'li') out.push('• ');
    if (tag === 'td' || tag === 'th') out.push(' ');
    el.childNodes.forEach(walk);
    if (tag === 'a') {
      const href = el.getAttribute('href');
      if (href && href !== el.textContent) out.push(` (${href})`);
    }
    if (tag === 'td' || tag === 'th') out.push(' |');
    if (tag === 'tr') out.push('\n');
    if (['p', 'div', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'ul', 'ol', 'pre', 'figure', 'table'].includes(tag)) out.push('\n\n');
    if (tag === 'li') out.push('\n');
  };
  doc.body.childNodes.forEach(walk);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}
