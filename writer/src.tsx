import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkDirective from 'remark-directive';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { parseSidebar } from './sidebar.mjs';
import './native';
import { createRoot } from 'react-dom/client';
import {
  AlertCircle, Archive, ArrowRight, Bold, BookOpen, Braces, Check, CheckCircle2, ChevronRight,
  CircleHelp, Code2, Columns2, ExternalLink, Eye, FilePlus2, FileText, FolderOpen,
  Heading1, Heading2, Heading3, Image, Info, Italic, Link2, List, ListOrdered, Loader2,
  Menu, MessageSquareText, Plus, Quote, RefreshCw, Save, Search, Command as CommandIcon,
  SeparatorHorizontal, Settings2, ShieldAlert, Sparkles, Table2, Terminal, Underline,
  Video, X, Trash2, Copy, Redo2, Undo2, Moon, Sun, Palette,
} from 'lucide-react';
import './style.css';

class MarkdownErrorBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.warn('Visual rendering fell back to source mode:', error); }
  render() {
    if (this.state.failed) return <div className="visual-error"><AlertCircle size={18}/><b>This block could not be rendered visually.</b><span>Edit its MDX in Text mode, or use Local preview to check the Markdown.</span></div>;
    return this.props.children;
  }
}

type PageInfo = { path: string; title: string };
type SidebarNode = { text:string; link:string; collapsed:boolean; external:boolean; items:SidebarNode[]; filePath?:string };
type ProjectInfo = { root: string; pagesDir: string; name: string; pages: PageInfo[]; sidebar?: SidebarNode[] };
type DesktopBridge = {
  chooseProject: () => Promise<ProjectInfo | null>;
  currentProject: () => Promise<ProjectInfo | null>;
  listPages: () => Promise<PageInfo[]>;
  readPage: (file: string) => Promise<string>;
  savePage: (file: string, content: string) => Promise<{ path: string; absolutePath: string; pages: PageInfo[] }>;
  preview: (file: string) => Promise<string>;
  onPreviewStatus: (listener: (status: string) => void) => Promise<() => void>;
  openFolder: () => Promise<void>;
  openPreview: (url: string) => Promise<void>;
};
declare global { interface Window { vocsEditorDesktop?: DesktopBridge; showDirectoryPicker?: (options?: {mode?:'read'|'readwrite'})=>Promise<any> } }

type BrowserProject = ProjectInfo & { handle: any; pagesHandle: any };
let browserProject: BrowserProject | null = null;
const CONFIGS = ['vocs.config.ts','vocs.config.js','vocs.config.mjs','vocs.config.mts'];
const PAGE_DIRS = ['src/pages','pages','docs/pages'];
const icons: Record<string, React.ReactNode> = {
  Text:<FileText size={16}/>, Heading:<Heading2 size={16}/>, 'Bulleted list':<List size={16}/>, 'Numbered list':<ListOrdered size={16}/>,
  Image:<Image size={16}/>, Video:<Video size={16}/>, Code:<Code2 size={16}/>, Callout:<MessageSquareText size={16}/>, Info:<Info size={16}/>, Success:<CheckCircle2 size={16}/>,
  Note:<CircleHelp size={16}/>, Tip:<Sparkles size={16}/>, Warning:<AlertCircle size={16}/>, Danger:<ShieldAlert size={16}/>,
  Steps:<ListOrdered size={16}/>, 'File tree':<FolderOpen size={16}/>, 'Code group':<Columns2 size={16}/>, Terminal:<Terminal size={16}/>,
  Prompt:<Braces size={16}/>, Changelog:<Archive size={16}/>, Benchmarks:<Table2 size={16}/>, Quote:<Quote size={16}/>, Table:<Table2 size={16}/>, Link:<Link2 size={16}/>, Divider:<SeparatorHorizontal size={16}/>,
  Cards:<Columns2 size={16}/>, Card:<FileText size={16}/>, Tabs:<Columns2 size={16}/>, Tab:<FileText size={16}/>, Badge:<CheckCircle2 size={16}/>,
};
const palette = [
  { title:'Text', items:['Text','Heading','Bulleted list','Numbered list','Quote','Divider','Link','Table'] },
  { title:'Media', items:['Image','Video'] },
  { title:'Vocs elements', items:['Callout','Note','Info','Tip','Success','Warning','Danger','Steps','File tree','Code group','Code','Terminal','Prompt','Changelog','Benchmarks','Cards','Card','Tabs','Tab','Badge'] },
];
const snippet: Record<string,string> = {
  Text:'Write your text here.', Heading:'## Section heading', 'Bulleted list':'- First item\n- Second item', 'Numbered list':'1. First step\n2. Second step',
  Quote:'> Add a quote here.', Divider:'---', Link:'[Link text](https://example.com)',
  Table:'| Column 1 | Column 2 |\n| --- | --- |\n| Value | Value |', Image:'![Describe the image](/images/example.png)',
  Video:'<video controls src="/videos/example.mp4"></video>', Code:'```bash\nnpm run dev\n```',
  Callout:'<Callout variant="info">\n\nHelpful information goes here.\n\n</Callout>',
  Note:'<aside data-v-callout data-v-context="note">\n\nA useful note goes here.\n\n</aside>',
  Info:'<aside data-v-callout data-v-context="info">\n\nHelpful information goes here.\n\n</aside>',
  Tip:'<aside data-v-callout data-v-context="tip">\n\nA helpful tip goes here.\n\n</aside>',
  Success:'<aside data-v-callout data-v-context="success">\n\nThis worked successfully.\n\n</aside>',
  Warning:'<aside data-v-callout data-v-context="warning">\n\nBe careful about this.\n\n</aside>',
  Danger:'<aside data-v-callout data-v-context="danger">\n\nThis action can cause data loss.\n\n</aside>',
  Steps:'<div data-v-steps>\n\n<div>\n\n### First step\n\nDescribe what to do.\n\n</div>\n\n<div>\n\n### Second step\n\nDescribe the next action.\n\n</div>\n\n</div>',
  'File tree':`<div data-v-file-tree data-v-file-tree-items='[{"name":"src","type":"folder","items":[{"name":"index.ts","type":"file"}]},{"name":"package.json","type":"file"}]'></div>`,
  'Code group':'<div data-v-code-group>\n\n<div data-title="npm">\n\n```bash\nnpm install\n```\n\n</div>\n\n<div data-title="pnpm">\n\n```bash\npnpm install\n```\n\n</div>\n\n</div>',
  Terminal:'<div data-v-terminal>\n\n<div data-v-terminal-command>\n\n```bash\nnpm run dev\n```\n\n</div>\n\n<div data-v-terminal-output>\n\n```text\nServer ready\n```\n\n</div>\n\n</div>',
  Prompt:'<pre data-v-prompt="npm run dev"></pre>',
  Changelog:'<div data-v-changelog data-v-changelog-limit="5"></div>',
  Benchmarks:'<div data-v-benchmarks>\n\nDescribe benchmark results here.\n\n</div>',
  Cards:'<Cards>\n<Card title="Getting started" to="/getting-started" description="Set up your project and make your first page."></Card>\n<Card title="Configuration" to="/configuration" description="Learn about the available options."></Card>\n</Cards>',
  Card:'<Card title="Getting started" to="/getting-started" description="Set up your project and make your first page."></Card>',
  Tabs:'<Tabs>\n<Tab title="npm">\n\nUse npm to install the package.\n\n</Tab>\n<Tab title="pnpm">\n\nUse pnpm to install the package.\n\n</Tab>\n</Tabs>',
  Tab:'<Tab title="Example">\n\nAdd the content for this tab.\n\n</Tab>',
  Badge:':badge[Beta]{info}',
};

function titleFromSource(source:string, fallback:string) {
  const fm = source.match(/^---\s*\n([\s\S]*?)\n---/);
  const title = fm?.[1].match(/^title:\s*["']?(.*?)["']?\s*$/m)?.[1];
  return title?.trim() || fallback;
}
function contentFromSource(source:string) { return source.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, ''); }
function frontmatterFromSource(source:string) { return source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || ''; }
function composeSource(body:string, title:string, originalFrontmatter='') {
  if (originalFrontmatter) {
    let front = originalFrontmatter;
    if (/^title:/m.test(front)) front = front.replace(/^title:.*$/m, `title: ${JSON.stringify(title)}`);
    else front = `title: ${JSON.stringify(title)}\n${front}`;
    return `---\n${front}\n---\n${body}`;
  }
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${body}`;
}
function toSlug(title:string) { return title.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'untitled'; }
function routeForFile(file:string) { const parts=file.replace(/\.(md|mdx)$/i,'').split('/');if(parts[parts.length-1]==='index')parts.pop();return parts.filter(Boolean).map(encodeURIComponent).join('/'); }

const vocsSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames||[]), 'aside', 'video', 'source', 'details', 'summary', 'callout', 'cards', 'card', 'tabs', 'tab', 'badge'],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*']||[]), 'variant','title','description','to','dataVContext','dataVBadge','dataVDeadLink','dataVTitle','dataVocsCallout','dataVocsVariant','dataVocsTitle','dataVSteps','dataVFileTree','dataVFileTreeItems','dataVCodeGroup','dataTitle','dataVTerminal','dataVTerminalCommand','dataVTerminalOutput','dataVPrompt','dataVChangelog','dataVChangelogLimit','dataVBenchmarks'],
    aside: [...(defaultSchema.attributes?.aside||[]), 'dataVCallout','dataVContext','dataVTitle','dataVocsCallout','dataVocsVariant','dataVocsTitle'],
    div: [...(defaultSchema.attributes?.div||[]), 'dataVSteps','dataVFileTree','dataVFileTreeItems','dataVCodeGroup','dataTitle','dataVTerminal','dataVTerminalCommand','dataVTerminalOutput','dataVChangelog','dataVChangelogLimit','dataVBenchmarks'],
    pre: [...(defaultSchema.attributes?.pre||[]), 'dataVPrompt','dataVLang','dataVCode'],
    span: [...(defaultSchema.attributes?.span||[]), 'dataVBadge','dataVContext','dataVDeadLink'],
    a: [...(defaultSchema.attributes?.a||[]), 'dataVDeadLink'],
    video: ['controls','src','poster','width','height','autoPlay','loop','muted','playsInline'],
    source: ['src','type'],
  },
};
function vocsDirectives(){return (tree:any)=>{const visit=(node:any)=>{for(const child of node.children||[])visit(child);if(node.type==='containerDirective'&&['note','info','warning','danger','tip','success'].includes(node.name)){let title='';if(node.children?.[0]?.data?.directiveLabel){title=(node.children[0].children||[]).map((item:any)=>item.value||'').join('');node.children=node.children.slice(1);}node.data={...(node.data||{}),hName:'aside',hProperties:{'data-vocs-callout':'','data-vocs-variant':node.name,'data-vocs-title':title}};}else if(node.type==='textDirective'&&node.name==='badge'){const variant=Object.keys(node.attributes||{}).find((key:string)=>['note','info','warning','danger','tip','success'].includes(key))||'info';node.data={...(node.data||{}),hName:'span',hProperties:{'data-v-badge':'','data-v-context':variant}};}};visit(tree);};}
function mdxPlugins(){return {remark:[remarkGfm,remarkDirective,vocsDirectives],rehype:[rehypeRaw,[rehypeSanitize,vocsSchema]]} as any;}
function sourceRange(node:any){const start=node?.position?.start?.offset,end=node?.position?.end?.offset;return Number.isInteger(start)&&Number.isInteger(end)?{start,end}:null;}
function domToMarkdown(node:Node):string{
  if(node.nodeType===Node.TEXT_NODE)return node.textContent||'';
  if(node.nodeType!==Node.ELEMENT_NODE)return '';
  const element=node as HTMLElement,tag=element.tagName.toLowerCase();
  if(tag==='br')return '\n';
  const children=Array.from(element.childNodes).map(domToMarkdown).join('');
  if(tag==='strong'||tag==='b')return `**${children}**`;
  if(tag==='em'||tag==='i')return `_${children}_`;
  if(tag==='code')return `\`${children.replace(/`/g,'\\`')}\``;
  if(tag==='del'||tag==='s')return `~~${children}~~`;
  if(tag==='u')return `<u>${children}</u>`;
  if(tag==='span'&&element.hasAttribute('data-v-badge'))return `:badge[${children}]{${element.getAttribute('data-v-context')||'info'}}`;
  if(tag==='a')return `[${children}](${element.getAttribute('href')||''})`;
  if(tag==='div'||tag==='p')return children?`${children}\n`:'';
  return children;
}
function editableModel(body:string,range:{start:number;end:number},kind:string){
  const raw=body.slice(range.start,range.end);
  const card=raw.match(/^<Card\b([^>]*)(?:\/|>)\s*(?:<\/Card>)?$/i);
  if(card){const attr=(name:string)=>card[1].match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1]||'';return {type:'card',title:attr('title'),description:attr('description'),to:attr('to')};}
  const tab=raw.match(/^<Tab\b([^>]*)>([\s\S]*?)<\/Tab>$/i);
  if(tab)return {type:'tab',title:tab[1].match(/\btitle=["']([^"']*)["']/)?.[1]||'',content:tab[2].trim()};
  const badge=raw.match(/^:badge\[([\s\S]*?)\](?:\{(note|info|warning|danger|tip|success)\})?$/);
  if(badge)return {type:'badge',label:badge[1],variant:badge[2]||'info'};
  const jsxBadge=raw.match(/^<Badge\b([^>]*)>([\s\S]*?)<\/Badge>$/i);
  if(jsxBadge)return {type:'badge',label:jsxBadge[2].trim(),variant:jsxBadge[1].match(/variant=["']([^"']+)/)?.[1]||'info',syntax:'jsx'};
  const todo=raw.match(/^\[([\s\S]+?)\]\(\/TODO(?:#[^)]*)?\)$/);
  if(todo)return {type:'todo',label:todo[1]};
  const directive=raw.match(/^:::(note|info|warning|danger|tip|success)(?:\[([^\]]*)\])?\s*\n?([\s\S]*?)\n?:::$/);
  if(directive)return {type:'callout',variant:directive[1],title:directive[2]||'',content:directive[3]||''};
  const htmlCallout=raw.match(/^<aside\b([^>]*)>([\s\S]*?)<\/aside>$/i);
  if(htmlCallout&&/data-v-callout/.test(htmlCallout[1]))return {type:'callout',variant:htmlCallout[1].match(/data-v-context=["']([^"']+)/)?.[1]||'info',title:htmlCallout[1].match(/data-v-title=["']([^"']*)/)?.[1]||'',content:htmlCallout[2].trim()};
  const heading=raw.match(/^(#{1,6})\s+([\s\S]*?)\s*#*\s*$/);
  if(heading)return {type:'heading',level:heading[1].length,content:heading[2]};
  const code=raw.match(/^(```+|~~~+)([^\n]*)\n([\s\S]*?)\n\1\s*$/);
  if(code)return {type:'code',language:code[2].trim(),content:code[3]};
  return {type:kind==='paragraph'?'text':kind,content:raw};
}
function composeEditable(model:any){
  if(model.type==='callout')return `:::${model.variant||'info'}${model.title?`[${model.title}]`:''}\n${model.content}\n:::`;
  if(model.type==='heading')return `${'#'.repeat(Math.max(1,Math.min(6,Number(model.level)||2)))} ${model.content}`;
  if(model.type==='code')return `\`\`\`${model.language||''}\n${model.content}\n\`\`\``;
  if(model.type==='card')return `<Card title=${JSON.stringify(model.title||'Card title')} to=${JSON.stringify(model.to||'/')} description=${JSON.stringify(model.description||'')}></Card>`;
  if(model.type==='tab')return `<Tab title=${JSON.stringify(model.title||'Tab')}>

${model.content||''}

</Tab>`;
  if(model.type==='badge')return model.syntax==='jsx'?`<Badge variant="${model.variant||'info'}">${model.label||'Status'}</Badge>`:`:badge[${model.label||'Status'}]{${model.variant||'info'}}`;
  if(model.type==='todo')return `[${model.label||'TODO'}](/TODO)`;
  return model.content;
}

async function browserList(handle:any, prefix=''):Promise<PageInfo[]> {
  const result:PageInfo[]=[];
  for await (const [name,entry] of handle.entries()) {
    if(name.startsWith('.') || name==='node_modules') continue;
    if(entry.kind==='directory') result.push(...await browserList(entry, prefix?`${prefix}/${name}`:name));
    else if (/\.(md|mdx)$/i.test(name)) { const p=prefix?`${prefix}/${name}`:name; result.push({path:p,title:p.replace(/\.(md|mdx)$/i,'').split('/').pop()!.replace(/[-_]/g,' ')}); }
  }
  return result.sort((a,b)=>a.path.localeCompare(b.path));
}
async function chooseBrowserProject():Promise<ProjectInfo|null> {
  if(!window.showDirectoryPicker) throw new Error('This browser cannot connect to folders. Open this editor in the desktop app or use a current Chromium-based browser.');
  const root=await window.showDirectoryPicker({mode:'readwrite'});
  const pkgFile=await root.getFileHandle('package.json').catch(()=>null);
  let pkg:any={};if(pkgFile){try{pkg=JSON.parse(await (await pkgFile.getFile()).text());}catch{pkg={};}}
  let configured=false, sourceDir='src', sidebar:SidebarNode[]=[];
  for(const c of CONFIGS) { const config=await root.getFileHandle(c).catch(()=>null);if(config){configured=true;try{const text=await (await config.getFile()).text();const match=text.match(/\bsrcDir\s*:\s*['"]([^'"]+)['"]/);if(match)sourceDir=match[1].replace(/^\.\//,'').replace(/\/$/,'');sidebar=parseSidebar(text) as SidebarNode[];}catch{}} }
  const hasVocs=Boolean(pkg.dependencies?.vocs||pkg.devDependencies?.vocs||pkg.peerDependencies?.vocs);
  let pagesHandle:any=null, pagesDir='';
  const candidates=[...new Set([`${sourceDir}/pages`,...PAGE_DIRS])];
  let emptyCandidate:string|undefined;
  for(const candidate of candidates){
    let h=root;
    try{
      for(const part of candidate.split('/')) h=await h.getDirectoryHandle(part);
      if(!emptyCandidate)emptyCandidate=candidate;
      if((await browserList(h)).length){pagesHandle=h;pagesDir=candidate;break;}
    }catch{}
  }
  if(!pagesHandle){
    const rootPages=await browserList(root);
    if((configured||hasVocs)&&emptyCandidate){pagesDir=emptyCandidate;pagesHandle=root;for(const p of pagesDir.split('/'))pagesHandle=await pagesHandle.getDirectoryHandle(p);}
    else if(rootPages.length){pagesDir='.';pagesHandle=root;}
    else if(configured||hasVocs){pagesDir=`${sourceDir}/pages`;pagesHandle=root;for(const p of pagesDir.split('/'))pagesHandle=await pagesHandle.getDirectoryHandle(p,{create:true});}
    else if(emptyCandidate){pagesDir=emptyCandidate;pagesHandle=root;for(const p of pagesDir.split('/'))pagesHandle=await pagesHandle.getDirectoryHandle(p);}
    else throw new Error('Choose a folder with Markdown pages, or a Vocs project folder.');
  }
  browserProject={root:root.name,pagesDir,name:root.name,pages:[],sidebar,handle:root,pagesHandle};
  browserProject.pages=await browserList(pagesHandle);
  return {root:root.name,pagesDir,name:root.name,pages:browserProject.pages,sidebar};
}

function fileHierarchy(pages:PageInfo[]):SidebarNode[]{
  const root:SidebarNode={text:'',link:'',collapsed:false,external:false,items:[]};
  for(const page of pages){const parts=page.path.split('/');let cursor=root.items;for(const dir of parts.slice(0,-1)){let group=cursor.find(item=>item.text===dir&&!item.filePath);if(!group){group={text:dir,link:'',collapsed:false,external:false,items:[]};cursor.push(group);}cursor=group.items;}const routePage={text:page.title,link:'',collapsed:false,external:false,items:[],filePath:page.path};cursor.push(routePage);}
  return root.items;
}
function pageForLink(link:string,pages:PageInfo[]){
  if(!link||/^(https?:|mailto:)/i.test(link))return undefined;
  let route=link.split('#')[0].split('?')[0].replace(/^\/+|\/+$/g,'');try{route=decodeURIComponent(route);}catch{}
  const exact=pages.find(page=>page.path.replace(/\.(md|mdx)$/i,'').replace(/\/index$/,'')===route);
  if(exact)return exact;
  if(!route){return pages.find(page=>/^index\.(md|mdx)$/i.test(page.path));}
  return pages.find(page=>page.path.replace(/\.(md|mdx)$/i,'')===`${route}/index`);
}
function FileTreeItem({item,depth=0}:{item:any;depth?:number}){
  const [open,setOpen]=useState(true);const folder=item.type==='folder';return <li className="filetree-item" style={{paddingLeft:depth*16}}>{folder?<><button onClick={()=>setOpen(!open)}><ChevronRight className={open?'tree-open':''} size={13}/><FolderOpen size={14}/>{item.name}</button>{item.items?.length>0&&open&&<ul>{item.items.map((child:any,i:number)=><FileTreeItem key={`${child.name}-${i}`} item={child} depth={depth+1}/>)}</ul>}</>:<div><FileText size={13}/>{item.name}</div>}</li>;
}
function VocsCodeGroup({children}:React.PropsWithChildren){
  const items=React.Children.toArray(children).filter(React.isValidElement) as React.ReactElement[];const [active,setActive]=useState(0);if(!items.length)return null;const current=items[Math.min(active,items.length-1)];return <div className="visual-code-group"><div className="visual-code-tabs">{items.map((item,index)=><button key={index} className={active===index?'active':''} onClick={()=>setActive(index)}>{(item.props as any)['data-title']||(item.props as any).dataTitle||`Example ${index+1}`}</button>)}</div><div className="visual-code-content">{current}</div></div>;
}
function nodeAttr(props:any,name:string){return props[name]??props[name.replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase())];}

function App(){
  const desktop=window.vocsEditorDesktop;
  const [project,setProject]=useState<ProjectInfo|null>(null),[pages,setPages]=useState<PageInfo[]>([]),[currentFile,setCurrentFile]=useState(''),[title,setTitle]=useState('Untitled page'),[body,setBody]=useState(''),[frontmatter,setFrontmatter]=useState(''),[activeTab,setActiveTab]=useState<'insert'|'page'|'block'>('insert');
  const [search,setSearch]=useState(''),[status,setStatus]=useState('Connect a docs folder to begin'),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[previewBase,setPreviewBase]=useState(()=>{try{return localStorage.getItem('vocs-editor-preview-url')||'http://localhost:5173'}catch{return 'http://localhost:5173'}}),[previewUrl,setPreviewUrl]=useState(''),[previewError,setPreviewError]=useState(''),[showPreview,setShowPreview]=useState(false),[previewMode,setPreviewMode]=useState<'local'|'vocs'>('local'),[previewRefresh,setPreviewRefresh]=useState(0),[showNav,setShowNav]=useState(true);
  const [darkMode,setDarkMode]=useState(()=>{try{const saved=localStorage.getItem('vocs-editor-theme');return saved?saved==='dark':Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches)}catch{return false}});
  const [accentTheme,setAccentTheme]=useState<'slate'|'ocean'|'violet'|'ember'>(()=>{try{const saved=localStorage.getItem('vocs-editor-accent');return saved==='ocean'||saved==='violet'||saved==='ember'?saved:'slate'}catch{return 'slate'}});
  const [themeMenuOpen,setThemeMenuOpen]=useState(false);
  const [commandOpen,setCommandOpen]=useState(false),[commandQuery,setCommandQuery]=useState(''),[commandIndex,setCommandIndex]=useState(0);
  const commandInput=useRef<HTMLInputElement>(null);
  const [visualTextSelection,setVisualTextSelection]=useState(false);
  const [viewMode,setViewMode]=useState<'visual'|'text'>('visual'),[selectedRange,setSelectedRange]=useState<{start:number;end:number;kind:string}|null>(null),[hierarchyMode,setHierarchyMode]=useState<'vocs'|'files'>('files'),[expandedNav,setExpandedNav]=useState<Record<string,boolean>>({});
  const [splitRatio,setSplitRatio]=useState(()=>{try{return Number(localStorage.getItem('vocs-editor-split')||55)}catch{return 55}}),[previewZoom,setPreviewZoom]=useState(()=>{try{return Number(localStorage.getItem('vocs-editor-zoom')||100)}catch{return 100}}),[dragging,setDragging]=useState<{item:string;x:number;y:number;grabX:number;grabY:number;rotation:number}|null>(null);
  const textarea=useRef<HTMLTextAreaElement>(null),caret=useRef(0),dirtyRef=useRef(false),fileRef=useRef(''),dragSession=useRef<any>(null),suppressPaletteClick=useRef(false),bodyRef=useRef(body);
  const historyRef=useRef<{undo:Array<{body:string;title:string;range:typeof selectedRange}>;redo:Array<{body:string;title:string;range:typeof selectedRange}>;lastTyping:number}>({undo:[],redo:[],lastTyping:0});
  const localClipboard=useRef('');
  const selectedRangeRef=useRef(selectedRange);selectedRangeRef.current=selectedRange;
  const visualActionsRef=useRef<{selectNode:(node:any,kind:string)=>void;commitInline:(node:any,element:HTMLElement)=>void}>({selectNode:()=>{},commitInline:()=>{}});
  const setDocumentBody=(value:string)=>{bodyRef.current=value;setBody(value);};
  const markDirty=(value:boolean)=>{dirtyRef.current=value;setDirty(value);};
  const recordHistory=(typing=false)=>{
    const history=historyRef.current,now=Date.now();
    if(typing&&now-history.lastTyping<900){history.lastTyping=now;return;}
    history.undo.push({body:bodyRef.current,title,range:selectedRange});
    if(history.undo.length>100)history.undo.shift();
    history.redo=[];history.lastTyping=typing?now:0;
  };
  const restoreHistory=(direction:'undo'|'redo')=>{
    const history=historyRef.current,from=direction==='undo'?history.undo:history.redo,to=direction==='undo'?history.redo:history.undo;
    const state=from.pop();if(!state)return;
    to.push({body:bodyRef.current,title,range:selectedRange});
    setDocumentBody(state.body);setTitle(state.title);setSelectedRange(state.range);markDirty(true);setStatus(direction==='undo'?'Undid change':'Redid change');history.lastTyping=0;
  };
  const filteredPages=pages.filter(p=>p.path.toLowerCase().includes(search.toLowerCase()));
  const selectedPage=pages.find(p=>p.path===currentFile);
  const selectedModel=selectedRange?editableModel(body,selectedRange,selectedRange.kind):null;
  const navNodes=hierarchyMode==='vocs'&&project?.sidebar?.length?project.sidebar:fileHierarchy(pages);
  const markdownPlugins=useMemo(()=>mdxPlugins(),[]);
  useEffect(()=>{const update=()=>{const selection=window.getSelection(),anchor=selection?.anchorNode;const owner=anchor?.nodeType===Node.ELEMENT_NODE?anchor as Element:anchor?.parentElement;const inEditor=Boolean(viewMode==='visual'&&selection&&!selection.isCollapsed&&selection.toString()&&owner?.closest('.visual-sheet .visual-body [contenteditable="true"]'));setVisualTextSelection(value=>value===inEditor?value:inEditor);};document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);},[viewMode]);
  useEffect(()=>{if(!desktop?.onPreviewStatus)return;let unlisten:(()=>void)|undefined;let cancelled=false;desktop.onPreviewStatus(message=>setStatus(message)).then(stop=>{if(cancelled)stop();else unlisten=stop;}).catch(error=>console.warn('Could not listen for preview status:',error));return()=>{cancelled=true;unlisten?.();};},[desktop]);
  useEffect(()=>{try{localStorage.setItem('vocs-editor-split',String(splitRatio));localStorage.setItem('vocs-editor-zoom',String(previewZoom));localStorage.setItem('vocs-editor-accent',accentTheme);localStorage.setItem('vocs-editor-preview-url',previewBase);}catch{}},[splitRatio,previewZoom,accentTheme,previewBase]);
  const selectNode=(node:any,kind:string)=>{const range=sourceRange(node);if(range){setSelectedRange({...range,kind});setActiveTab('block');}};
  const commitInline=(node:any,element:HTMLElement)=>{const range=sourceRange(node);if(!range)return;let replacement=Array.from(element.childNodes).map(domToMarkdown).join('');const current=bodyRef.current;const original=current.slice(range.start,range.end);if(element.dataset.sourceKind==='list-item'){const prefix=original.match(/^(\s*(?:[-+*]|\d+[.)])\s+)/)?.[1]||'';replacement=`${prefix}${replacement.trim()}`;}if(replacement===original)return;recordHistory();setDocumentBody(current.slice(0,range.start)+replacement+current.slice(range.end));setSelectedRange({start:range.start,end:range.start+replacement.length,kind:element.dataset.sourceKind||'paragraph'});markDirty(true);setStatus('Unsaved changes');};
  visualActionsRef.current={selectNode,commitInline};
  const visualProps=(node:any,kind:string)=>{const range=sourceRange(node);return range?{'data-source-start':range.start,'data-source-end':range.end,'data-source-kind':kind,'data-selected':selectedRangeRef.current?.start===range.start?'true':undefined,'onClick':(e:React.MouseEvent)=>{e.stopPropagation();visualActionsRef.current.selectNode(node,kind);}}:{onClick:undefined};};
  const buildMarkdownComponents=(editableText:boolean)=>{
    const inline=(Tag:any,kind:string,cls='')=>({node,children,...props}:any)=>{const editable=editableText&&['paragraph','heading','list-item'].includes(kind);return <Tag {...props} className={`${props.className||''} mdx-node ${cls}`} {...visualProps(node,kind)} contentEditable={editable} suppressContentEditableWarning={editable} spellCheck={editable} onInput={editable?()=>{markDirty(true);setStatus('Unsaved visual edit');}:undefined} onBlur={editable?(e:React.FocusEvent<HTMLElement>)=>{if(e.currentTarget===e.target)visualActionsRef.current.commitInline(node,e.currentTarget);}:undefined}>{children}</Tag>;};
    const selectContainer=(node:any,kind:string)=>({onClickCapture:(e:React.MouseEvent)=>{if((e.target as HTMLElement).closest('[contenteditable="true"]'))return;e.stopPropagation();visualActionsRef.current.selectNode(node,kind);}});
    return {
      h1:inline('h1','heading'),h2:inline('h2','heading'),h3:inline('h3','heading'),h4:inline('h4','heading'),h5:inline('h5','heading'),h6:inline('h6','heading'),
      p:inline('p','paragraph'),ul:inline('ul','list'),ol:inline('ol','list'),blockquote:inline('blockquote','blockquote'),li:inline('li','list-item'),
      pre:({node,children,...props}:any)=>{const prompt=nodeAttr(props,'data-v-prompt');return prompt?<div className="vocs-prompt" {...visualProps(node,'prompt')}><span>Run this command</span><code>{prompt}</code></div>:<pre {...props} className="mdx-code-block" {...visualProps(node,'code')}>{children}</pre>},
      img:({node,...props}:any)=><img {...props} className="mdx-node" {...visualProps(node,'image')}/>,
      hr:({node,...props}:any)=><hr {...props} {...visualProps(node,'divider')}/>,
      input:({node,...props}:any)=><input {...props} readOnly className="mdx-node" {...visualProps(node,'task')} onClick={e=>{e.preventDefault();visualActionsRef.current.selectNode(node,'task');}}/>,
      video:({node,...props}:any)=><video {...props} className="mdx-node" {...visualProps(node,'video')} onClick={e=>{e.preventDefault();visualActionsRef.current.selectNode(node,'video');}}/>,
      aside:({node,children,...props}:any)=>{const variant=nodeAttr(props,'data-vocs-variant')||nodeAttr(props,'data-v-context')||'info';const title=nodeAttr(props,'data-vocs-title')||nodeAttr(props,'data-v-title')||variant.charAt(0).toUpperCase()+variant.slice(1);return <aside className={`vocs-callout callout-${variant}`} {...visualProps(node,'callout')} {...selectContainer(node,'callout')}><div className="callout-heading"><span className="callout-icon">{variant==='warning'||variant==='danger'?<AlertCircle size={16}/>:variant==='success'?<CheckCircle2 size={16}/>:<Info size={16}/>}</span><b>{title}</b></div><div className="callout-content">{children}</div></aside>;},
      callout:({node,children,...props}:any)=><aside className={`vocs-callout callout-${props.variant||'info'}`} {...visualProps(node,'callout')} {...selectContainer(node,'callout')}><div className="callout-heading"><span className="callout-icon">{props.variant==='warning'||props.variant==='danger'?<AlertCircle size={16}/>:props.variant==='success'?<CheckCircle2 size={16}/>:<Info size={16}/>}</span><b>{props.title||props.variant||'Info'}</b></div><div className="callout-content">{children}</div></aside>,
      badge:({node,children,...props}:any)=><span data-v-badge="" data-v-context={props.variant||'info'} className={`vocs-badge badge-${props.variant||'info'} mdx-node`} {...visualProps(node,'badge')}>{children}</span>,
      cards:({node,children,...props}:any)=><div className="vocs-cards" {...visualProps(node,'cards')}>{children}</div>,
      card:({node,...props}:any)=><a href={props.to||'#'} className="vocs-card" {...visualProps(node,'card')} onClick={e=>{e.preventDefault();visualActionsRef.current.selectNode(node,'card');}}><b>{props.title||'Card title'}</b><span>{props.description||''}</span></a>,
      tabs:({node,children,...props}:any)=><div className="vocs-mdx-tabs" {...visualProps(node,'tabs')}>{children}</div>,
      tab:({node,children,...props}:any)=><section className="vocs-mdx-tab" {...visualProps(node,'tab')}><h3>{props.title||'Tab'}</h3>{children}</section>,
      div:({node,children,...props}:any)=>{const fileItems=nodeAttr(props,'data-v-file-tree-items');if(nodeAttr(props,'data-v-file-tree')!==undefined&&fileItems){let parsed:any[]=[];try{parsed=JSON.parse(fileItems)}catch{}return <div className="vocs-file-tree" {...visualProps(node,'file-tree')}><ul>{parsed.map((item:any,index)=><FileTreeItem key={`${item.name}-${index}`} item={item}/>)}</ul></div>;}
        if(nodeAttr(props,'data-v-code-group')!==undefined)return <div {...visualProps(node,'code-group')}><VocsCodeGroup>{children}</VocsCodeGroup></div>;
        if(nodeAttr(props,'data-v-steps')!==undefined)return <div className="vocs-steps" {...visualProps(node,'steps')}>{children}</div>;
        if(nodeAttr(props,'data-v-terminal')!==undefined)return <div className="vocs-terminal" {...visualProps(node,'terminal')}>{children}</div>;
        if(nodeAttr(props,'data-v-changelog')!==undefined)return <div className="vocs-feature-card" {...visualProps(node,'changelog')}><Archive size={17}/><div><b>Vocs changelog</b><span>Rendered from the connected project's changelog configuration.</span></div></div>;
        if(nodeAttr(props,'data-v-benchmarks')!==undefined)return <div className="vocs-benchmarks" {...visualProps(node,'benchmarks')}><Table2 size={16}/><div>{children}</div></div>;
        return <div {...props} className={`${props.className||''} mdx-node`} {...visualProps(node,'container')}>{children}</div>;},
      table:({node,children,...props}:any)=><div className="mdx-table-wrap" {...visualProps(node,'table')}><table {...props}>{children}</table></div>,
      span:({node,children,...props}:any)=>{const variant=nodeAttr(props,'data-v-context')||'info';if(nodeAttr(props,'data-v-badge')!==undefined)return <span data-v-badge="" data-v-context={variant} className={`vocs-badge badge-${variant} mdx-node`} {...visualProps(node,'badge')}>{children}</span>;return <span {...props} {...visualProps(node,'span')}>{children}</span>;},
      a:({node,children,...props}:any)=>{const todo=props.href==='/TODO'||nodeAttr(props,'data-v-dead-link')!==undefined;return <a {...props} className={todo?'vocs-todo-link':props.className} title={todo?'TODO — page not written yet':props.title} {...visualProps(node,todo?'todo':'link')} onClick={e=>{e.preventDefault();visualActionsRef.current.selectNode(node,todo?'todo':'link');}}>{children}</a>;},
    } as any;
  };
  const markdownComponents=useMemo(()=>buildMarkdownComponents(true),[]);
  const previewMarkdownComponents=useMemo(()=>buildMarkdownComponents(false),[]);
  const updateSelected=(field:string,value:string)=>{if(!selectedRange||!selectedModel)return;recordHistory(true);const next={...selectedModel,[field]:value};const replacement=composeEditable(next);const start=selectedRange.start,end=selectedRange.end,current=bodyRef.current;setDocumentBody(current.slice(0,start)+replacement+current.slice(end));const range={start,end:start+replacement.length,kind:selectedRange.kind};setSelectedRange(range);markDirty(true);setStatus('Unsaved visual edit');};
  const replaceSourceRange=(range:{start:number;end:number;kind:string},replacement:string,statusText='Unsaved changes')=>{recordHistory();const current=bodyRef.current;setDocumentBody(current.slice(0,range.start)+replacement+current.slice(range.end));setSelectedRange(replacement?{start:range.start,end:range.start+replacement.length,kind:range.kind}:null);markDirty(true);setStatus(statusText);};
  const insertTextAt=(kind:string,forcedOffset?:number)=>{const current=bodyRef.current,text=snippet[kind]||'';const el=textarea.current;const start=forcedOffset??(viewMode==='text'&&el?el.selectionStart:(selectedRange?.end??current.length));const end=forcedOffset??(viewMode==='text'&&el?el.selectionEnd:start);const before=current.slice(0,start),after=current.slice(end);const sep=before&&!before.endsWith('\n\n')?'\n\n':'';const next=`${before}${sep}${text}\n\n${after}`;recordHistory();setDocumentBody(next);const mark={start:start+sep.length,end:start+sep.length+text.length,kind:'inserted'};setSelectedRange(mark);markDirty(true);setStatus(`Inserted ${kind}`);caret.current=mark.end;if(viewMode==='text')requestAnimationFrame(()=>{textarea.current?.focus();textarea.current?.setSelectionRange(mark.end,mark.end);});};
  const beginPaletteDrag=(event:React.PointerEvent,item:string)=>{if(event.button!==0)return;event.preventDefault();const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();const session={item,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,grabX:event.clientX-rect.left,grabY:event.clientY-rect.top,active:false,lastX:event.clientX,lastY:event.clientY,rotation:0};dragSession.current=session;
    const move=(e:PointerEvent)=>{const s=dragSession.current;if(!s)return;const dx=e.clientX-s.startX,dy=e.clientY-s.startY;if(!s.active&&Math.hypot(dx,dy)>5){s.active=true;suppressPaletteClick.current=true;document.body.classList.add('dragging-vocs-element');}if(s.active){const velocity=e.clientX-s.lastX;s.x=e.clientX;s.y=e.clientY;s.rotation=Math.max(-10,Math.min(10,velocity*1.35));s.lastX=e.clientX;s.lastY=e.clientY;setDragging({item:s.item,x:s.x,y:s.y,grabX:s.grabX,grabY:s.grabY,rotation:s.rotation});const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.page-sheet');document.querySelector('.page-sheet')?.classList.toggle('drop-ready',Boolean(target));}};
    const cleanup=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',cancel);document.body.classList.remove('dragging-vocs-element');document.querySelector('.page-sheet')?.classList.remove('drop-ready');dragSession.current=null;setDragging(null);};
    const cancel=()=>cleanup();
    const up=(e:PointerEvent)=>{const s=dragSession.current;cleanup();if(!s?.active){suppressPaletteClick.current=true;insertTextAt(item);window.setTimeout(()=>{suppressPaletteClick.current=false;},0);return;}const target=document.elementFromPoint(e.clientX,e.clientY) as HTMLElement|null;const sheet=target?.closest('.page-sheet');if(sheet){suppressPaletteClick.current=true;const block=target?.closest<HTMLElement>('[data-source-end]');const offset=block?Number(block.dataset.sourceEnd):undefined;insertTextAt(item,Number.isFinite(offset)?offset:undefined);window.setTimeout(()=>{suppressPaletteClick.current=false;},0);}};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});window.addEventListener('pointercancel',cancel,{once:true});};
  const resizeSplit=(event:React.PointerEvent)=>{event.preventDefault();const container=event.currentTarget.parentElement;if(!container)return;const rect=container.getBoundingClientRect();const horizontal=getComputedStyle(container).flexDirection!=='column';const move=(e:PointerEvent)=>{const coordinate=horizontal?e.clientX-rect.left:e.clientY-rect.top;const span=(horizontal?rect.width:rect.height)-9;setSplitRatio(Math.max(25,Math.min(75,Math.round(coordinate/Math.max(span,1)*100))));};const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);document.body.classList.remove('resizing-split');};document.body.classList.add('resizing-split');window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});};

  const refreshPages=useCallback(async()=>{
    const list=desktop?await desktop.listPages():browserProject?await browserList(browserProject.pagesHandle):[];
    setPages(list); if(browserProject) browserProject.pages=list; return list;
  },[desktop]);
  const openPage=useCallback(async(file:string)=>{
    if(file!==fileRef.current&&dirtyRef.current&&!window.confirm('This page has unsaved edits. Discard them and open another page?'))return;
    try{setBusy(true);const data=desktop?await desktop.readPage(file):await (async()=>{if(!browserProject)throw new Error('Connect a project first.');let h=browserProject.pagesHandle;for(const segment of file.split('/').slice(0,-1))h=await h.getDirectoryHandle(segment);const fh=await h.getFileHandle(file.split('/').pop()!);return (await fh.getFile()).text()})();
      historyRef.current={undo:[],redo:[],lastTyping:0};setCurrentFile(file);fileRef.current=file;setTitle(titleFromSource(data,file.split('/').pop()!.replace(/\.(md|mdx)$/i,'')));setFrontmatter(frontmatterFromSource(data));setDocumentBody(contentFromSource(data));setSelectedRange(null);setActiveTab('insert');setViewMode('visual');markDirty(false);setStatus(`Opened ${file}`);setShowPreview(false);
    }catch(e){setStatus(errorText(e));}finally{setBusy(false);}
  },[desktop]);
  useEffect(()=>{if(!desktop)return;desktop.currentProject().then(async p=>{if(p){setProject(p);setPages(p.pages);setHierarchyMode(p.sidebar?.length?'vocs':'files');if(p.pages[0])void openPage(p.pages[0].path);else setStatus(`Connected to ${p.name}. Create your first page.`);}}).catch(e=>setStatus(errorText(e)));},[desktop,openPage]);

  const connect=async()=>{const discard=dirtyRef.current;if(discard&&!window.confirm('You have unsaved edits. Discard them and connect another project?'))return;try{setBusy(true);setStatus('Choose your docs folder…');const p=desktop?await desktop.chooseProject():await chooseBrowserProject();if(!p)return;if(discard)markDirty(false);setProject(p);setPages(p.pages);setHierarchyMode(p.sidebar?.length?'vocs':'files');setStatus(`Connected to ${p.name} · ${p.pagesDir}`);if(p.pages[0])await openPage(p.pages[0].path);else startNew();}catch(e){setStatus(errorText(e));}finally{setBusy(false);}};
  const startNew=()=>{if(dirtyRef.current&&!window.confirm('This page has unsaved edits. Discard them and start a new page?'))return;historyRef.current={undo:[],redo:[],lastTyping:0};setCurrentFile('');fileRef.current='';setTitle('Untitled page');setFrontmatter('');setDocumentBody('');setSelectedRange(null);setActiveTab('insert');markDirty(false);setStatus('New page · not saved yet');setShowPreview(false);};
  const ensureFile=()=>currentFile || `${toSlug(title)}.mdx`;
  const save=async():Promise<boolean>=>{if(!project){setStatus('Connect your Vocs project first.');return false;}try{setBusy(true);const file=ensureFile();const doc=composeSource(bodyRef.current,title,frontmatter);if(desktop){const result=await desktop.savePage(file,doc);setPages(result.pages);}else{if(!browserProject)throw new Error('Reconnect your project and grant folder access to save.');let h=browserProject.pagesHandle;const segs=file.split('/');for(const segment of segs.slice(0,-1))h=await h.getDirectoryHandle(segment,{create:true});const fh=await h.getFileHandle(segs.at(-1)!,{create:true});const writer=await fh.createWritable();await writer.write(doc);await writer.close();setPages(await browserList(browserProject.pagesHandle));}
      setCurrentFile(file);fileRef.current=file;markDirty(false);setStatus(`Saved ${file}`);if(showPreview&&previewMode==='vocs')setPreviewRefresh(value=>value+1);return true;
    }catch(e){setStatus(errorText(e));return false;}finally{setBusy(false);}};
  const offlinePreview=()=>{setPreviewError('');setPreviewMode('local');setShowPreview(true);setStatus('Offline Markdown preview · no project dependencies needed');};
  const preview=()=>{void previewVocs();};
  const previewVocs=async()=>{
    if(!project){setStatus('Connect a Vocs project to run the Vocs site.');return;}
    try{
      setPreviewError('');setPreviewUrl('');
      const file=ensureFile();
      if((dirty||!currentFile)&&!(await save()))return;
      setPreviewMode('vocs');setShowPreview(true);setBusy(true);setStatus('Starting the Vocs development server…');
      let url:string;
      if(desktop)url=await desktop.preview(file);
      else {
        let parsed:URL;
        try{parsed=new URL(previewBase.trim());}catch{throw new Error('Enter a valid preview address, such as http://localhost:5173.');}
        if(!['http:','https:'].includes(parsed.protocol))throw new Error('The preview address must start with http:// or https://.');
        const base=`${parsed.origin}${parsed.pathname.replace(/\/+$/,'')}`;
        const controller=new AbortController(),timeout=window.setTimeout(()=>controller.abort(),6000);
        try{await fetch(`${base}/`,{mode:'no-cors',signal:controller.signal});}
        catch{throw new Error(`Could not reach ${base} within 6 seconds. Start the docs site's dev server and try again.`);}
        finally{window.clearTimeout(timeout);}
        const route=routeForFile(file);url=route?`${base}/${route}`:`${base}/`;
      }
      setPreviewUrl(url);setStatus(`Vocs site previewing ${url}`);
    }catch(e){const message=errorText(e);setPreviewError(message);setPreviewMode('vocs');setShowPreview(true);setStatus(`Could not start Vocs preview: ${message}`);}
    finally{setBusy(false);}
  };
  const openPreviewInBrowser=()=>{if(!previewUrl)return;if(desktop)void desktop.openPreview(previewUrl);else window.open(previewUrl,'_blank','noopener,noreferrer');};
  const formatVisualSelection=(command:string)=>{const selection=window.getSelection();if(!selection||selection.isCollapsed)return;let html='';if(command==='code'||command==='link'){const element=document.createElement(command==='code'?'code':'a');element.textContent=selection.toString();if(command==='link')element.setAttribute('href','https://example.com');html=element.outerHTML;document.execCommand('insertHTML',false,html);}else document.execCommand(command,false);};
  const insert=(kind:string)=>{if(suppressPaletteClick.current){suppressPaletteClick.current=false;return;}insertTextAt(kind);};
  const wrapSelection=(before:string,after=before)=>{const el=textarea.current;if(!el)return;const current=bodyRef.current,a=el.selectionStart,b=el.selectionEnd,selected=current.slice(a,b)||'text';recordHistory();const value=current.slice(0,a)+before+selected+after+current.slice(b);setDocumentBody(value);markDirty(true);requestAnimationFrame(()=>{el.focus();el.setSelectionRange(a+before.length,a+before.length+selected.length);});};
  const handleBody=(v:string)=>{recordHistory(true);setDocumentBody(v);markDirty(true);setStatus('Unsaved changes');};
  const handleTitle=(v:string)=>{recordHistory(true);setTitle(v);markDirty(true);setStatus('Unsaved changes');};
  const deleteSelected=()=>{if(!selectedRange)return;let {start,end}=selectedRange;const current=bodyRef.current;if(current.slice(end,end+2)==='\n\n')end+=2;else if(current.slice(start-2,start)==='\n\n')start-=2;replaceSourceRange({...selectedRange,start,end},'','Removed block');setActiveTab('insert');};
  const duplicateSelected=()=>{const el=viewMode==='text'?textarea.current:null;if(el){const current=bodyRef.current,a=el.selectionStart,b=el.selectionEnd;let start=a,end=b;if(a===b){start=current.lastIndexOf('\n',Math.max(0,a-1))+1;end=current.indexOf('\n',a);if(end<0)end=current.length;}const text=current.slice(start,end);if(!text)return;recordHistory();setDocumentBody(current.slice(0,end)+`\n${text}`+current.slice(end));setSelectedRange(null);markDirty(true);setStatus('Duplicated text');requestAnimationFrame(()=>{el.focus();el.setSelectionRange(end+1,end+1+text.length);});return;}
    if(!selectedRange)return;const current=bodyRef.current,raw=current.slice(selectedRange.start,selectedRange.end);if(!raw)return;const insert=`\n\n${raw}`;recordHistory();setDocumentBody(current.slice(0,selectedRange.end)+insert+current.slice(selectedRange.end));setSelectedRange({start:selectedRange.end+2,end:selectedRange.end+2+raw.length,kind:selectedRange.kind});markDirty(true);setStatus('Duplicated block');};
  const nativeTextSelected=()=>{const active=document.activeElement as HTMLInputElement|HTMLTextAreaElement|null;return Boolean(window.getSelection()?.toString()||(active&&(active.tagName==='TEXTAREA'||active.tagName==='INPUT')&&active.selectionStart!==active.selectionEnd));};
  const isEditingSelectedInline=(active:HTMLElement|null=document.activeElement as HTMLElement|null)=>{const editable=active?.closest<HTMLElement>('[contenteditable="true"]');return Boolean(editable&&selectedRange&&Number(editable.dataset.sourceStart)===selectedRange.start);};
  const copySelected=()=>{if(!selectedRange)return;const value=bodyRef.current.slice(selectedRange.start,selectedRange.end);localClipboard.current=value;void navigator.clipboard?.writeText(value).catch(()=>{});};
  const pasteSourceText=(value:string,range=selectedRange)=>{if(!value||!range)return;replaceSourceRange(range,value,'Pasted block');};
  const handlePaste=(e:React.ClipboardEvent)=>{const active=document.activeElement as HTMLElement|null;if(active?.matches('input,textarea')||isEditingSelectedInline(active))return;if(!selectedRange)return;const value=e.clipboardData.getData('text/plain')||localClipboard.current;if(!value)return;e.preventDefault();pasteSourceText(value,selectedRange);};
  useEffect(()=>{
    const onKeyDown=(e:KeyboardEvent)=>{
      const mod=e.metaKey||e.ctrlKey,key=e.key.toLowerCase(),active=document.activeElement as HTMLElement|null;
      if(mod&&key==='s'){e.preventDefault();if(active?.isContentEditable)active.blur();void save();return;}
      if(mod&&e.shiftKey&&key==='p'){e.preventDefault();setCommandQuery('');setCommandOpen(true);requestAnimationFrame(()=>commandInput.current?.focus());return;}
      if(mod&&key==='z'){if(active?.isContentEditable)return;e.preventDefault();restoreHistory(e.shiftKey?'redo':'undo');return;}
      if(mod&&key==='y'){if(active?.isContentEditable)return;e.preventDefault();restoreHistory('redo');return;}
      if(mod&&viewMode==='text'&&key==='b'){e.preventDefault();wrapSelection('**');return;}
      if(mod&&viewMode==='text'&&key==='i'){e.preventDefault();wrapSelection('_');return;}
      if(mod&&viewMode==='text'&&key==='k'){e.preventDefault();wrapSelection('[','](https://example.com)');return;}
      const editing=Boolean(active?.matches('input,textarea'))||isEditingSelectedInline(active);
      const blockClipboardTarget=!active?.matches('input,textarea')&&!nativeTextSelected();
      if(mod&&key==='c'&&selectedRange&&blockClipboardTarget){e.preventDefault();copySelected();return;}
      if(mod&&key==='x'&&selectedRange&&blockClipboardTarget){e.preventDefault();copySelected();deleteSelected();return;}
      if(mod&&key==='v'&&selectedRange&&!editing){e.preventDefault();const range=selectedRange,read=navigator.clipboard?.readText();if(read)void read.then(value=>pasteSourceText(value||localClipboard.current,range)).catch(()=>pasteSourceText(localClipboard.current,range));else pasteSourceText(localClipboard.current,range);return;}
      if(mod&&key==='d'){if(active?.matches('input')||(viewMode==='visual'&&nativeTextSelected()))return;e.preventDefault();duplicateSelected();return;}
      if(!mod&&!e.altKey&&!e.shiftKey&&selectedRange&&!nativeTextSelected()&&!editing&&(key==='delete'||key==='backspace')){e.preventDefault();deleteSelected();return;}
      if(e.key==='Escape'&&selectedRange&&!editing){setSelectedRange(null);setActiveTab('insert');}
    };
    document.addEventListener('keydown',onKeyDown);return()=>document.removeEventListener('keydown',onKeyDown);
  },[viewMode,selectedRange,body,title]);
  const renderNavTree=(items:SidebarNode[],depth=0,parent='root'):React.ReactNode=>items.map((item,index)=>{const key=`${parent}/${item.text||item.link||index}`;const hasChildren=!!item.items?.length;const expanded=expandedNav[key]??!item.collapsed;const page=item.filePath?pages.find(p=>p.path===item.filePath):pageForLink(item.link,pages);const active=Boolean(page&&page.path===currentFile);return <div className="nav-tree-node" key={key}><div className={`nav-tree-row ${active?'active':''}`} style={{paddingLeft:9+depth*13}}>{hasChildren?<button className="tree-chevron" title={expanded?'Collapse section':'Expand section'} onClick={()=>setExpandedNav(v=>({...v,[key]:!expanded}))}><ChevronRight className={expanded?'tree-open':''} size={13}/></button>:<span className="tree-spacer"/>}<button className="tree-label" title={item.link||item.text} onClick={()=>page?void openPage(page.path):hasChildren&&setExpandedNav(v=>({...v,[key]:!expanded}))}>{hasChildren?<FolderOpen size={14}/>:<FileText size={14}/>}<span>{item.text||page?.title||item.link||'Section'}</span></button></div>{hasChildren&&expanded&&<div className="nav-tree-children">{renderNavTree(item.items,depth+1,key)}</div>}</div>});

  const commandItems=[
    ...(project?[{label:showPreview?'Hide preview':'Show live Vocs preview',detail:'Run the connected project with its real theme and components',icon:<Eye size={15}/>,run:()=>showPreview?setShowPreview(false):preview(),keywords:'preview vocs live site'}]:[]),
    {label:'Show offline Markdown preview',detail:'Use the built-in renderer without starting the docs site',icon:<BookOpen size={15}/>,run:offlinePreview,keywords:'offline markdown'},
    {label:viewMode==='visual'?'Switch to text mode':'Switch to visual mode',detail:'Change the editing view',icon:<Code2 size={15}/>,run:()=>setViewMode(viewMode==='visual'?'text':'visual'),keywords:'mode text visual'},
    {label:darkMode?'Use light appearance':'Use dark appearance',detail:'Change the editor theme',icon:darkMode?<Sun size={15}/>:<Moon size={15}/>,run:()=>setDarkMode(value=>{const next=!value;try{localStorage.setItem('vocs-editor-theme',next?'dark':'light')}catch{}return next}),keywords:'theme dark light'},
    {label:project?'Change docs folder':'Connect docs folder',detail:'Choose a Markdown folder or Vocs project',icon:<FolderOpen size={15}/>,run:()=>void connect(),keywords:'folder project connect'},
    ...(project?[{label:'Save page',detail:'Write changes to your docs',icon:<Save size={15}/>,run:()=>void save(),keywords:'save'}]:[]),
    ...pages.map(page=>({label:page.title,detail:page.path,icon:<FileText size={15}/>,run:()=>void openPage(page.path),keywords:page.path})),
    ...(project?['Text','Heading','Callout','Code','Badge'].map(item=>({label:`Insert ${item}`,detail:'Add a block at the cursor',icon:icons[item],run:()=>insertTextAt(item),keywords:`insert ${item}`})):[]),
  ];
  const visibleCommands=commandItems.filter(item=>`${item.label} ${item.detail} ${item.keywords}`.toLowerCase().includes(commandQuery.toLowerCase())).slice(0,9);

  return <div className={`app ${darkMode?'dark-mode':''}`} data-accent={accentTheme} onPaste={handlePaste}>
    <header className="topbar">
      <button className="icon-button nav-toggle" title="Toggle page list" onClick={()=>setShowNav(!showNav)}><Menu size={18}/></button>
      <div className="brand-mark"><BookOpen size={20}/></div><div className="brand">Vocs Graphical Editor</div>
      <div className="top-separator"/><div className="project-context">{project?<><span className="connected-dot"/>{project.name}</>:<span className="muted">No project connected</span>}</div>
      <div className="top-spacer"/>
      <div className={`save-state ${dirty?'unsaved':''}`}>{busy?<Loader2 className="spin" size={14}/>:dirty?<span className="state-dot"/>:<Check size={14}/>}<span>{status}</span></div>
      <button className="icon-button theme-toggle" aria-label={darkMode?'Switch to light mode':'Switch to dark mode'} title={darkMode?'Switch to light mode':'Switch to dark mode'} onClick={()=>setDarkMode(value=>{const next=!value;try{localStorage.setItem('vocs-editor-theme',next?'dark':'light')}catch{}return next})}>{darkMode?<Sun size={17}/>:<Moon size={17}/>}</button>
      <div className="theme-picker-wrap">
        <button className={`icon-button theme-picker-trigger ${themeMenuOpen?'active':''}`} aria-label="Choose editor theme" aria-expanded={themeMenuOpen} title="Editor themes" onClick={()=>setThemeMenuOpen(value=>!value)}><Palette size={17}/></button>
        {themeMenuOpen&&<><button className="theme-menu-dismiss" aria-label="Close theme menu" onClick={()=>setThemeMenuOpen(false)}/><div className="theme-menu" role="dialog" aria-label="Editor themes"><div className="theme-menu-heading"><b>Editor themes</b><span>Color the workspace your way</span></div>{([{id:'slate',label:'Slate',colors:['#e9edf1','#74808d','#37404a']},{id:'ocean',label:'Ocean',colors:['#e4f1f7','#4e9bb9','#17465b']},{id:'violet',label:'Violet',colors:['#efeafa','#8d78c6','#4d3c78']},{id:'ember',label:'Ember',colors:['#f8ece2','#cb8053','#70452e']}] as const).map(theme=><button key={theme.id} className={`theme-choice ${accentTheme===theme.id?'selected':''}`} onClick={()=>{setAccentTheme(theme.id);setThemeMenuOpen(false)}}><span className="theme-swatches">{theme.colors.map(color=><i key={color} style={{background:color}}/>)}</span><span>{theme.label}</span>{accentTheme===theme.id&&<Check size={14}/>}</button>)}</div></>}
      </div>
      <button className="icon-button command-trigger" aria-label="Open quick actions" title="Quick actions · Ctrl/⌘ Shift P" onClick={()=>{setCommandQuery('');setCommandOpen(true);requestAnimationFrame(()=>commandInput.current?.focus());}}><CommandIcon size={17}/></button>
      <button className="button secondary" onClick={()=>void connect()} disabled={busy}><FolderOpen size={16}/><span>{project?'Change folder':'Connect docs folder'}</span></button>
      <button className="button secondary" onClick={()=>project?void preview():offlinePreview()} disabled={busy} title={project?'Start the Vocs site and preview this page':'Preview Markdown locally'}><Eye size={16}/><span>{project?'Live Vocs':'Preview'}</span></button>
      <button className="button primary" onClick={()=>void save()} disabled={!project||busy} title="Save · Ctrl/⌘ S"><Save size={16}/><span>Save</span><kbd>Ctrl/⌘ S</kbd></button>
    </header>
    <div className={`workspace ${!showNav?'hide-nav':''}`}>
      {showNav&&<aside className="sidebar pages-sidebar">
        <div className="sidebar-head"><span>PROJECT NAVIGATION</span><button className="icon-button small" title="New page" disabled={!project} onClick={()=>{startNew();setTimeout(()=>document.querySelector<HTMLInputElement>('.title-input')?.focus(),0)}}><FilePlus2 size={16}/></button></div>
        {project&&<div className="project-pill"><FolderOpen size={14}/><span title={project.root}>{project.name}</span>{desktop&&<button className="icon-button tiny" title="Open project folder" onClick={()=>desktop.openFolder()}><ExternalLink size={13}/></button>}</div>}
        <div className="search-wrap"><Search size={15}/><input placeholder="Find a page" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button className="icon-button tiny" onClick={()=>setSearch('')}><X size={13}/></button>}</div>
        {project&&<div className="hierarchy-switch"><button className={hierarchyMode==='vocs'?'active':''} disabled={!project.sidebar?.length} title={project.sidebar?.length?'Use sidebar from vocs.config.ts':'No static sidebar found in vocs.config.ts'} onClick={()=>setHierarchyMode('vocs')}>Vocs config</button><button className={hierarchyMode==='files'?'active':''} onClick={()=>setHierarchyMode('files')}>Folders</button></div>}
        <div className="page-list">
          {!project?<div className="empty-sidebar"><FolderOpen size={24}/><b>Connect a folder</b><span>Choose your docs folder or Vocs project.</span><button className="button secondary" onClick={()=>void connect()}><Plus size={15}/>Choose folder</button></div>:
            search?filteredPages.map(p=><button className={`page-row ${currentFile===p.path?'active':''}`} key={p.path} onClick={()=>void openPage(p.path)}><FileText size={15}/><span>{p.title}</span><small>{p.path.includes('/')?p.path.split('/').slice(0,-1).join('/'):' '}</small></button>):pages.length?renderNavTree(navNodes):<div className="empty-pages"><span>No Markdown pages found in</span><code>{project.pagesDir}</code><button className="button secondary" onClick={()=>startNew()}>Create first page</button></div>}
        </div>
        {project&&<div className="sidebar-foot"><button className="text-button" onClick={()=>void refreshPages()}><RefreshCw size={14}/> Refresh page list</button><span>{pages.length} {pages.length===1?'page':'pages'}</span></div>}
      </aside>}
      <main className="editor-area">
        <div className="editor-toolbar">
          <div className="breadcrumb"><span>{project?.pagesDir||'Workspace'}</span><ChevronRight size={14}/><b>{selectedPage?.path||'New page'}</b>{dirty&&<span className="dirty-dot"/>}</div>
          <div className="mode-toggle"><button className={viewMode==='visual'?'active':''} onClick={()=>setViewMode('visual')} title="See the rendered page"><Eye size={14}/>Visual</button><button className={viewMode==='text'?'active':''} onClick={()=>setViewMode('text')} title="Edit the full Markdown and MDX source"><Code2 size={14}/>Text</button></div>
          {viewMode==='text'&&<div className="toolbar-tools">
            <div className="tool-group"><button title="Bold (⌘B)" onClick={()=>wrapSelection('**')}><Bold size={16}/></button><button title="Italic (⌘I)" onClick={()=>wrapSelection('_')}><Italic size={16}/></button><button title="Underline" onClick={()=>wrapSelection('<u>','</u>')}><Underline size={16}/></button><button title="Inline code" onClick={()=>wrapSelection('`')}><Code2 size={16}/></button><button title="Add link" onClick={()=>wrapSelection('[','](https://example.com)')}><Link2 size={16}/></button></div>
            <div className="tool-divider"/>
            <div className="tool-group"><button title="Heading 1" onClick={()=>insert('Heading')}><Heading1 size={17}/></button><button title="Bulleted list" onClick={()=>insert('Bulleted list')}><List size={16}/></button><button title="Numbered list" onClick={()=>insert('Numbered list')}><ListOrdered size={16}/></button><button title="Quote" onClick={()=>insert('Quote')}><Quote size={16}/></button></div>
          </div>}
          {viewMode==='visual'&&(visualTextSelection?<div className="toolbar-tools selection-tools" aria-label="Text formatting"><div className="tool-group"><button title="Bold · Ctrl/⌘ B" onMouseDown={e=>e.preventDefault()} onClick={()=>formatVisualSelection('bold')}><Bold size={16}/></button><button title="Italic · Ctrl/⌘ I" onMouseDown={e=>e.preventDefault()} onClick={()=>formatVisualSelection('italic')}><Italic size={16}/></button><button title="Underline" onMouseDown={e=>e.preventDefault()} onClick={()=>formatVisualSelection('underline')}><Underline size={16}/></button><button title="Inline code" onMouseDown={e=>e.preventDefault()} onClick={()=>formatVisualSelection('code')}><Code2 size={16}/></button><button title="Add link" onMouseDown={e=>e.preventDefault()} onClick={()=>formatVisualSelection('link')}><Link2 size={16}/></button></div></div>:<div className="visual-hint">Click text to edit · select a block to copy or adjust it</div>)}
          <div className="toolbar-actions"><div className="history-actions"><button className="icon-button small" aria-label="Undo" title="Undo · Ctrl/⌘ Z" disabled={!historyRef.current.undo.length} onClick={()=>restoreHistory('undo')}><Undo2 size={15}/></button><button className="icon-button small" aria-label="Redo" title="Redo · Ctrl/⌘ Shift Z" disabled={!historyRef.current.redo.length} onClick={()=>restoreHistory('redo')}><Redo2 size={15}/></button></div>{showPreview&&<span className="split-status">Editor {splitRatio}% · Preview {100-splitRatio}%</span>}<button className="view-toggle" disabled={busy} onClick={()=>showPreview?setShowPreview(false):project?void preview():offlinePreview()} title={project?'Run the Vocs site in this preview pane':'Open the local Markdown preview'}><Eye size={15}/>{showPreview?'Hide preview':project?'Live preview':'Markdown preview'}</button></div>
        </div>
        <div className={`editor-content ${showPreview?'with-preview':''}`}>
          <section className={`page-sheet ${viewMode==='visual'?'visual-sheet':'text-sheet'}`} style={showPreview?{flex:`${splitRatio} 1 0`}:undefined}>
            <div className="page-kicker">MDX DOCUMENT <span>·</span> {currentFile||'NEW PAGE'}</div>
            <input className="title-input" value={title} onChange={e=>handleTitle(e.target.value)} placeholder="Page title" aria-label="Page title"/>
            <div className="document-rule"/>
            {viewMode==='text'?<textarea ref={textarea} className="mdx-editor" value={body} onChange={e=>handleBody(e.target.value)} onSelect={e=>caret.current=e.currentTarget.selectionStart} onKeyUp={e=>caret.current=e.currentTarget.selectionStart} onClick={e=>caret.current=e.currentTarget.selectionStart} onDragOver={e=>{e.preventDefault();e.currentTarget.classList.add('drag-target')}} onDragLeave={e=>e.currentTarget.classList.remove('drag-target')} onDrop={e=>{e.preventDefault();e.currentTarget.classList.remove('drag-target');const kind=e.dataTransfer.getData('vocs-kind');if(kind)insert(kind)}} placeholder={project?'Write your Markdown and MDX here…':'Connect a Vocs project to start editing.'} disabled={!project} spellCheck />:<div className="visual-body" onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const kind=e.dataTransfer.getData('vocs-kind');if(kind)insert(kind)}}>{body.trim()?<MarkdownErrorBoundary key={`${currentFile}-${body}`}><ReactMarkdown remarkPlugins={markdownPlugins.remark} rehypePlugins={markdownPlugins.rehype} components={markdownComponents}>{body}</ReactMarkdown></MarkdownErrorBoundary>:project?<div className="visual-empty"><BookOpen size={20}/><b>Your page is ready</b><span>Type in Text mode, or drag an element here to build the page.</span></div>:null}</div>}
            {!project&&<div className="connect-cover"><div className="cover-icon"><FolderOpen size={26}/></div><h2>Open your docs</h2><p>Choose a folder with <code>.md</code> or <code>.mdx</code> files. Vocs config is optional; local editing and preview work without installing the docs site.</p><button className="button primary" onClick={()=>void connect()}><FolderOpen size={16}/> Connect docs folder</button><small>Your files stay on this computer.</small></div>}
            {project&&<div className="page-footnote"><span>Markdown + MDX</span><span>{body.length} characters</span></div>}
          </section>
          {showPreview&&<div className="splitter" role="separator" aria-orientation={window.innerWidth<=650?'horizontal':'vertical'} aria-label={`Resize panes. Editor ${splitRatio}%, preview ${100-splitRatio}%.`} onPointerDown={resizeSplit}><span>{splitRatio}% · {100-splitRatio}%</span></div>}
          {showPreview&&<section className="preview-pane" style={{flex:`${100-splitRatio} 1 0`}}><div className="preview-heading"><div><b>{previewMode==='local'?'Offline Markdown preview':'Live Vocs site'}</b><span>{previewMode==='local'?'Built-in renderer · no Node.js needed':previewUrl||'Vocs preview not running'}</span></div><div className="preview-actions">{previewMode==='local'?<button className="view-toggle" onClick={()=>void previewVocs()} disabled={!project||busy} title="Start the connected Vocs site"><Terminal size={14}/>Live Vocs</button>:<button className="view-toggle" onClick={offlinePreview} title="Use the built-in offline preview"><BookOpen size={14}/>Offline</button>}<label className="zoom-control" title="Preview zoom"><span>Zoom</span><select aria-label="Preview zoom" value={previewZoom} onChange={e=>setPreviewZoom(Number(e.target.value))}>{[50,67,75,90,100,110,125,150].map(v=><option key={v} value={v}>{v}%</option>)}</select></label>{previewMode==='vocs'&&<><button className="icon-button" onClick={()=>setPreviewRefresh(value=>value+1)} disabled={!previewUrl} title="Refresh live preview"><RefreshCw size={15}/></button><button className="icon-button" onClick={openPreviewInBrowser} disabled={!previewUrl} title="Open preview in browser"><ExternalLink size={15}/></button></>}<button className="icon-button" onClick={()=>setShowPreview(false)} title="Close preview"><X size={16}/></button></div></div>
            {!desktop&&previewMode==='vocs'&&<div className="preview-url"><input aria-label="Vocs preview address" value={previewBase} onChange={e=>setPreviewBase(e.target.value)} placeholder="http://localhost:5173"/><button className="button secondary" onClick={()=>void previewVocs()} disabled={busy}><RefreshCw size={14}/>Open</button></div>}
            {previewMode==='vocs'?previewUrl?<div className="preview-frame-wrap"><iframe key={`${previewUrl}-${previewRefresh}`} title="Live Vocs page preview" src={previewUrl} style={{width:`${10000/previewZoom}%`,height:`${10000/previewZoom}%`,transform:`scale(${previewZoom/100})`}}/></div>:<div className="preview-empty"><Eye size={25}/><b>{previewError?'Vocs preview could not start':busy?'Preparing live preview…':'Vocs preview is not running'}</b><p>{previewError||status}</p>{previewError&&<button className="button secondary" onClick={()=>void previewVocs()} disabled={busy}><RefreshCw size={14}/>Try again</button>}</div>:<div className="local-preview-canvas"><article className="local-preview-document" style={{zoom:`${previewZoom}%`}}><div className="local-preview-kicker">MARKDOWN + VOCS COMPONENTS</div><h1>{title}</h1><div className="local-preview-rule"/><div className="visual-body" onBeforeInput={e=>e.preventDefault()}>{body.trim()?<MarkdownErrorBoundary key={`local-${currentFile}-${body}`}><ReactMarkdown remarkPlugins={markdownPlugins.remark} rehypePlugins={markdownPlugins.rehype} components={previewMarkdownComponents}>{body}</ReactMarkdown></MarkdownErrorBoundary>:<div className="preview-empty"><Eye size={22}/><b>Nothing to preview yet</b><p>Add Markdown or a Vocs block and it will show here.</p></div>}</div></article></div>}
          </section>}
        </div>
      </main>
      <aside className="sidebar inspector">
        <div className="inspector-tabs"><button className={activeTab==='insert'?'selected':''} onClick={()=>setActiveTab('insert')}><Plus size={15}/>Insert</button>{selectedModel&&<button className={activeTab==='block'?'selected':''} onClick={()=>setActiveTab('block')}><Settings2 size={15}/>Block</button>}<button className={activeTab==='page'?'selected':''} onClick={()=>setActiveTab('page')}><Settings2 size={15}/>Page</button></div>
        {activeTab==='insert'?<div className="insert-panel"><div className="panel-intro"><b>Build your page</b><span>Add Markdown and Vocs MDX components at the cursor.</span></div>
          {palette.map(group=><section className="palette-group" key={group.title}><h3>{group.title}</h3><div className="palette-grid">{group.items.map(item=><button key={item} className="palette-item" onPointerDown={e=>beginPaletteDrag(e,item)} onClick={()=>insert(item)} disabled={!project||busy} title={`Click or drag to insert ${item}`}><span className="palette-icon">{icons[item]||<Braces size={16}/>}</span><span>{item}</span><Plus className="palette-add" size={13}/></button>)}</div></section>)}
          <div className="vocs-note"><div className="note-mark"><BookOpen size={15}/></div><div><b>Vocs-aware snippets</b><span>Uses Vocs 2.x built-in MDX blocks. Check that your project version supports each component.</span></div></div>
        </div>:activeTab==='block'&&selectedModel?<div className="block-settings"><div className="panel-intro"><b>Edit block</b><span>Changes update the document source.</span></div>
          {selectedModel.type==='callout'?<><label>CALLOUT TYPE</label><select value={selectedModel.variant} onChange={e=>updateSelected('variant',e.target.value)}>{['note','info','tip','success','warning','danger'].map(type=><option key={type} value={type}>{type[0].toUpperCase()+type.slice(1)}</option>)}</select><label>LABEL</label><input value={selectedModel.title} onChange={e=>updateSelected('title',e.target.value)} placeholder="Optional heading"/><label>CONTENT</label><textarea value={selectedModel.content} onChange={e=>updateSelected('content',e.target.value)} rows={8}/></>:selectedModel.type==='badge'?<><label>STATUS</label><select value={selectedModel.variant} onChange={e=>updateSelected('variant',e.target.value)}>{['note','info','tip','success','warning','danger'].map(type=><option key={type} value={type}>{type[0].toUpperCase()+type.slice(1)}</option>)}</select><label>BADGE TEXT</label><input value={selectedModel.label} onChange={e=>updateSelected('label',e.target.value)} placeholder="New, Beta, Stable…"/></>:selectedModel.type==='todo'?<><label>TODO LABEL</label><input value={selectedModel.label} onChange={e=>updateSelected('label',e.target.value)} placeholder="TODO"/><div className="todo-inspector-note">TODO links stay linked to Vocs’ /TODO marker.</div></>:selectedModel.type==='card'?<><label>CARD TITLE</label><input value={selectedModel.title} onChange={e=>updateSelected('title',e.target.value)} placeholder="Card title"/><label>DESCRIPTION</label><textarea value={selectedModel.description} onChange={e=>updateSelected('description',e.target.value)} rows={4}/><label>DESTINATION</label><input value={selectedModel.to} onChange={e=>updateSelected('to',e.target.value)} placeholder="/docs/page"/></>:selectedModel.type==='tab'?<><label>TAB TITLE</label><input value={selectedModel.title} onChange={e=>updateSelected('title',e.target.value)} placeholder="Tab"/><label>CONTENT</label><textarea value={selectedModel.content} onChange={e=>updateSelected('content',e.target.value)} rows={8}/></>:selectedModel.type==='heading'?<><label>HEADING LEVEL</label><select value={selectedModel.level} onChange={e=>updateSelected('level',e.target.value)}>{[1,2,3,4,5,6].map(level=><option key={level} value={level}>Heading {level}</option>)}</select><label>TEXT</label><textarea value={selectedModel.content} onChange={e=>updateSelected('content',e.target.value)} rows={4}/></>:selectedModel.type==='code'?<><label>LANGUAGE</label><input value={selectedModel.language} onChange={e=>updateSelected('language',e.target.value)} placeholder="bash, ts, json…"/><label>CODE</label><textarea className="code-field" value={selectedModel.content} onChange={e=>updateSelected('content',e.target.value)} rows={12}/></>:<><label>CONTENT</label><textarea value={selectedModel.content} onChange={e=>updateSelected('content',e.target.value)} rows={14}/></>}
          <div className="block-actions"><button className="text-button" onClick={duplicateSelected}><Copy size={14}/>Duplicate</button><button className="text-button danger-action" onClick={deleteSelected}><Trash2 size={14}/>Delete block</button></div>
          <div className="shortcut-hint">Delete or Backspace removes this block · Ctrl/⌘ D duplicates</div>
          <button className="text-button" onClick={()=>{setSelectedRange(null);setActiveTab('insert')}}><X size={14}/>Deselect block <span className="shortcut-key">Esc</span></button>
        </div>:<div className="page-settings"><div className="panel-intro"><b>Page settings</b><span>Frontmatter is preserved when you save.</span></div><label>PAGE TITLE</label><input value={title} onChange={e=>handleTitle(e.target.value)} disabled={!project}/><label>FILE PATH</label><input value={currentFile||`${toSlug(title)}.mdx`} onChange={e=>{setCurrentFile(e.target.value);fileRef.current=e.target.value;markDirty(true)}} disabled={!project}/><label>PREVIEW ROUTE</label><div className="route-preview">/{routeForFile(currentFile||`${toSlug(title)}.mdx`)}</div><div className="settings-actions"><button className="button secondary full" onClick={()=>void save()} disabled={!project||busy}><Save size={15}/>Save page</button><button className="text-button" onClick={()=>void connect()}><FolderOpen size={14}/>Change project</button></div></div>}
      </aside>
    </div>
    {dragging&&<div className="drag-ghost" style={{left:dragging.x-dragging.grabX,top:dragging.y-dragging.grabY,transform:`rotate(${dragging.rotation}deg)`}}><span className="palette-icon">{icons[dragging.item]||<Braces size={16}/>}</span><span>{dragging.item}</span></div>}
    {commandOpen&&<div className="command-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setCommandOpen(false);}}><section className="command-dialog" role="dialog" aria-modal="true" aria-label="Quick actions"><div className="command-search"><Search size={17}/><input ref={commandInput} value={commandQuery} onChange={e=>{setCommandQuery(e.target.value);setCommandIndex(0);}} onKeyDown={e=>{if(e.key==='Escape'){setCommandOpen(false);return;}if(e.key==='ArrowDown'){e.preventDefault();setCommandIndex(i=>Math.min(i+1,visibleCommands.length-1));return;}if(e.key==='ArrowUp'){e.preventDefault();setCommandIndex(i=>Math.max(0,i-1));return;}if(e.key==='Enter'&&visibleCommands[commandIndex]){visibleCommands[commandIndex].run();setCommandOpen(false);}}} placeholder="Search pages and actions…"/><kbd>ESC</kbd></div><div className="command-list">{visibleCommands.length?visibleCommands.map((item,index)=><button className={`command-item ${commandIndex===index?'active':''}`} key={`${item.label}-${index}`} onMouseEnter={()=>setCommandIndex(index)} onClick={()=>{item.run();setCommandOpen(false);}}><span className="command-item-icon">{item.icon}</span><span className="command-item-copy"><b>{item.label}</b><small>{item.detail}</small></span><ArrowRight size={14}/></button>):<div className="command-empty">No matching pages or actions.</div>}</div><footer><span>Quick actions</span><span><kbd>↑↓</kbd> Move · <kbd>↵</kbd> Run · <kbd>esc</kbd> Close</span></footer></section></div>}
  </div>;
}
function errorText(e:unknown){if(e instanceof DOMException && e.name==='AbortError')return 'Folder selection cancelled.';return e instanceof Error?e.message:String(e)}

createRoot(document.getElementById('root')!).render(<App/>);
