// Browser-only visual fixture. Native calls are mocked: no processes or user files are changed.
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { useRepoStore } from '../../src/stores/useRepoStore';
import { useTerminalStore } from '../../src/stores/useTerminalStore';
import { useProjectSettingsStore } from '../../src/stores/useProjectSettingsStore';
import { useTerminalSettingsStore } from '../../src/stores/useTerminalSettingsStore';
import { useUsageSettingsStore } from '../../src/stores/useUsageSettingsStore';
import { useThemeStore } from '../../src/stores/useThemeStore';
import { useChatStore } from '../../src/stores/useChatStore';
import { useUIStore } from '../../src/stores/useUIStore';
import { emptyChat } from '../../src/lib/acp/chatModel';
import { startChat } from '../../src/lib/acp/chatSessions';
import { CODING_ASSISTANTS } from '../../src/components/sidebar/constants';
import { mockChatCommand } from './chatPreview';
import { mockAvailability } from './availabilityPreview';
import { antigravityMock, mockAntigravityCommand, finishAntigravityAuth } from '../antigravity-chat/mockAntigravity';
import type { PortInfo, RepoInfo, SessionHistoryEntry } from '../../src/lib/types';
import '../../src/styles/globals.css';

// Keep the fixture mounted while testing the real app's live-session hot reload.
if (import.meta.hot) import.meta.hot.accept('../../src/lib/acp/chatSessions', () => {});

const params = new URLSearchParams(location.search);
antigravityMock.installed = !['missing', 'error'].includes(params.get('adapter') ?? '');
antigravityMock.installError = params.get('adapter') === 'error';
let previewPorts: PortInfo[] = params.get('ports') === 'empty' ? [] : [
  {port:5173,pid:1234,process:'node',framework:'Vite',project:'shep',cwd:'/preview/shep',memory_kb:148480,uptime:'02:14:32'},
  {port:8787,pid:1235,process:'node',framework:'Express',project:'shep',cwd:'/preview/shep/api',memory_kb:58368,uptime:'02:12:08'},
  {port:4000,pid:2345,process:'beam.smp',framework:'Phoenix',project:'springroll',cwd:'/preview/springroll',memory_kb:286720,uptime:'01:28:04'},
  {port:5174,pid:2346,process:'node',framework:'Vite',project:'springroll',cwd:'/preview/springroll/web',memory_kb:129024,uptime:'01:25:41'},
  {port:8080,pid:3456,process:'python3',framework:'',project:'',cwd:'/preview/tools/local-development/long-running-preview-server',memory_kb:24576,uptime:'12-03:08:14'},
];
let portScans = 0;
let repoScans = 0;
const changedFiles = params.get('changes') === 'empty' ? [] : [
  { path: 'src/App.tsx', status: 'M', area: 'unstaged', old_path: null },
  { path: 'src/styles/globals.css', status: 'M', area: 'unstaged', old_path: null },
  { path: 'package.json', status: 'M', area: 'unstaged', old_path: null },
  { path: 'README.md', status: 'M', area: 'unstaged', old_path: null },
  { path: 'src/components/shared/OptionGroup.tsx', status: '?', area: 'untracked', old_path: null },
];
const previewFile = 'export default function App() {\n  return <main>Start an agent.</main>;\n}\n';
const repos: RepoInfo[] = ['shep', 'springroll', 'springroll-website', 'carrot-frontend', 'carrot-backend', 'design-system', 'dotfiles', 'blog', 'infra', 'scratch'].map((name, i) => ({ name, path: `/preview/${name}`, group: i < 3 ? 'workspace' : i < 6 ? 'projects' : null, pinned: name === 'springroll', last_opened: Date.now() - i * 3_600_000 * 7 }));
// A discovered worktree of shep, nested under it in the sidebar and on the Projects page.
repos.push({ name: 'acp-chat', path: '/preview/.shep-worktrees/shep/acp-chat', group: 'workspace', pinned: false, last_opened: null });
const groups = [{id:'workspace',name:'Workspace',order:0,pinned:params.get('pinGroup') !== 'none'},{id:'projects',name:'Projects',order:1,pinned:true}];
const cost = { amount: 4.82, kind: 'estimated', basis: 'local-pricing', confidence: 'estimated' };
const now = Date.now();
const historyDate = (days: number) => {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return date.getTime();
};
const histories: SessionHistoryEntry[] = params.get('history') === 'empty' ? [] : [
  {title:'Workspace design',provider:'claude',projectPath:repos[0].path,model:'Sonnet',days:0},
  {title:'Add keyboard navigation to menus',provider:'codex',projectPath:repos[0].path,model:null,days:0},
  {title:'Build the project activity view',provider:'claude',projectPath:repos[1].path,model:'Sonnet',days:1},
  {title:'Investigate slow startup',provider:'cursor',projectPath:repos[0].path,model:null,days:1},
  {title:'Make a very long conversation title fit comfortably alongside project names and model details',provider:'codex',projectPath:'/preview/springroll-website',model:'Reasoning model with a long display name',days:3},
  {title:'Review the shared navigation',provider:'antigravity',projectPath:repos[1].path,model:null,days:4},
  {title:'Explore a new approach',provider:'grok',projectPath:repos[0].path,model:null,days:10},
  {title:null,provider:'claude',projectPath:'/preview/archived-project',model:null,days:14},
].map(({days,...session},i) => ({...session,sessionId:`sample-${i}`,startedAt:historyDate(days)-3600000,lastActivityAt:historyDate(days),endedAt:i ? historyDate(days) : null}));
let historyScans = 0;
let previewPtyId = 1000;
const snapshots = ['claude', 'codex', 'cursor'].map((provider, i) => ({provider,status:'ok',fetchedAt:new Date().toISOString(),summaryWindows:[{provider,windowId:`${provider}-weekly`,window:'7d',label:'7d',scope:'plan',limit:100,used:24+i*18,sourceType:'provider',confidence:'official',costKind:'included',usedPercent:24+i*18,remainingPercent:76-i*18,resetAt:new Date(now+3*86400000).toISOString(),tokenTotal:null,paceStatus:null}],extraWindows:[],localDetails:null,error:null}));
// Labels as agents really log them: Claude by encoded path, Codex by folder name.
const usageItem = (provider: string, label: string, tokens: number, sessions: number | null = null) => ({provider,label,tokens,tokensInput:Math.round(tokens*0.04),tokensOutput:Math.round(tokens*0.02),tokensCacheRead:Math.round(tokens*0.9),tokensCacheWrite:Math.round(tokens*0.04),tokensThoughts:0,cost:null,costDetail:cost,sessions,trend:[]});
const usageOverview = (window: string) => {
  const scale = {'24h':0.05,'7d':0.3,'30d':1,'365d':4}[window] ?? 1;
  const count = {'24h':24,'7d':7,'30d':30,'365d':365}[window] ?? 24;
  const hourly = window === '24h';
  const topModels = [['claude','claude-opus-5-5',1240],['antigravity','Gemini 3.7 Flash (Low)',220],['claude','claude-sonnet-5',130],['codex','gpt-6-astra',73],['claude','claude-fable-5-1',67],['codex','gpt-5.6-sol',54],['antigravity','unknown',19],['codex','gpt-6.1-sol',7.5],['antigravity','Gemini 3.7 Flash (Low',0.6],['antigravity','Gemini 3.7 Fl',0.5],['pi','~deepseek/deepseek-flash-latest',0.4],['pi','moonshotai/kimi-k3',0.2],['claude','<synthetic>',0]].map(([p,l,t]) => usageItem(p as string,l as string,Math.round((t as number)*1e6*scale)));
  const topProjects = [['claude','-preview-shep',514,19],['claude','-preview-carrot-frontend',489,14],['antigravity','unknown',241,40],['claude','-preview-springroll',213,7],['codex','shep',108,18],['claude','-preview--shep-worktrees-shep-acp-chat',60,1],['codex','springroll',14,6],['codex','carrot-frontend',12,4],['claude','subagents',5.6,16],['codex','let-s-set-up-a-scheduled',0.6,1],['claude','-private-tmp-claude-501--preview-springroll-scratchpad',0.09,7],['codex','dev',0.19,1],['pi','carrot-frontend',0.05,1]].map(([p,l,t,n]) => usageItem(p as string,l as string,Math.round((t as number)*1e6*scale),n as number));
  const providers = [['claude',1437],['antigravity',241],['codex',134],['pi',0.6]].map(([p,t]) => ({...usageItem(p as string,'',Math.round((t as number)*1e6*scale)),sharePercent:0}));
  const totalTokens = providers.reduce((sum, p) => sum + p.tokens, 0);
  const unit = hourly ? 3600000 : 86400000;
  const trend = Array.from({length:count},(_,i)=>({start:now-(count-i)*unit,end:now-(count-1-i)*unit,label:'',tokens:Math.round(Math.max(0,Math.sin(i*1.7)+Math.sin(i*0.37)*0.8+0.4)*totalTokens/count),cost:null,costDetail:cost,providers:[]}));
  return {window,totalTokens,totalCost:null,totalCostDetail:cost,activeProjects:6,activeSessions:Math.round(80*scale)+1,providers,trend,topModels,topProjects};
};
const config = { name: 'shep', commands: params.has('autostart') ? [{name:'serve',command:'echo fixture',autostart:true,env:{},cwd:'app'}] : [], assistants: [] };
const git = { is_git_repo: true, branch: 'design/springroll', dirty: changedFiles.length > 0, staged: 0, unstaged: changedFiles.filter(file => file.area === 'unstaged').length, untracked: changedFiles.filter(file => file.area === 'untracked').length, ahead: 0, behind: 0, worktree_parent: null };
mockWindows('main');
mockIPC((cmd, payload) => {
  if (cmd.startsWith('plugin:')) {
    if (cmd === 'plugin:dialog|open') return params.get('folder') === 'cancel' ? null : '/preview/new-project';
    if (cmd.endsWith('version')) return '0.8.4';
    if (cmd.includes('is_permission_granted')) return true;
    return null;
  }
  const args = payload as Record<string, unknown> | undefined;
  if (cmd === 'get_managed_acp_adapter' || cmd === 'check_command_exists') return mockAvailability(cmd, args ?? {});
  if (cmd === 'install_managed_acp_adapter') return mockAntigravityCommand(cmd, args ?? {});
  if (cmd === 'open_url' && params.get('chat') === 'antigravity') {
    document.body.dataset.previewGoogleSignIn = 'opened';
    for (const call of antigravityMock.calls.filter(call => call.method === 'authenticate')) finishAntigravityAuth(call.chatId);
    return null;
  }
  if (['spawn_acp_agent','write_acp_agent','kill_acp_agent'].includes(cmd)) return mockChatCommand(cmd, args ?? {}, params.get('chat'));
  // Give project switching distinct totals, including a clean repository.
  const repoChanges = args?.path === '/preview/springroll-website' ? []
    : args?.path === '/preview/springroll' ? changedFiles.slice(0, 2) : changedFiles;
  switch (cmd) {
    case 'list_repos': {
      repoScans++;
      if (params.get('repos') === 'error' && repoScans === 1) return Promise.reject('Cannot read existing config');
      if (params.get('repos') === 'empty') return [];
      if (params.get('repos') === 'slow') return new Promise(resolve => { (window as any).releasePreviewRepos = () => resolve(repos.map(repo => ({...repo}))); });
      return repos.map(repo => ({...repo}));
    }
    case 'list_groups': return groups.map(group => ({...group}));
    case 'suggest_project_folders': return params.get('suggest') === 'none' ? [] : [
      {path:'/Users/designer/dev/affix-pipeline',name:'affix-pipeline',lastUsed:Date.now()-2*86400000,agent:'codex'},
      {path:'/Users/designer/dev/marketing-site',name:'marketing-site',lastUsed:Date.now()-5*3600000,agent:'claude'},
    ];
    case 'set_group_pinned': { const group = groups.find(g => g.id === args?.groupId); if (group) group.pinned = Boolean(args?.pinned); return null; }
    case 'set_repo_pinned': { const repo = repos.find(r => r.path === args?.repoPath); if (repo) repo.pinned = Boolean(args?.pinned); return null; }
    case 'mark_repo_opened': { const repo = repos.find(r => r.path === args?.repoPath); if (repo) repo.last_opened = Date.now(); return repo?.last_opened ?? Date.now(); }
    case 'move_repo_to_group': { const repo = repos.find(r => r.path === args?.repoPath); if (repo) repo.group = (args?.groupId as string | null) ?? null; return null; }
    case 'create_group': {
      const group = {id:`group-${groups.length}`,name:String(args?.name),order:groups.length,pinned:true};
      groups.push(group);
      return group;
    }
    case 'register_repo': {
      const path = String(args?.repoPath);
      const name = path.split('/').pop() ?? 'new-project';
      if (!repos.some(repo => repo.path === path)) repos.push({name,path,group:null,pinned:false,last_opened:null});
      return {path,workspace:{...config,name}};
    }
    case 'load_workspace': return config;
    case 'get_project_settings': return useProjectSettingsStore.getState().settings;
    case 'save_project_settings': return null;
    case 'get_terminal_settings': return useTerminalSettingsStore.getState().settings;
    case 'get_usage_settings': return useUsageSettingsStore.getState().settings;
    case 'get_editor_settings': return { preferredEditor: 'vscode' };
    case 'get_username': return 'Designer';
    case 'get_storage_warning': return params.get('storage') === 'error' ? 'Session history and usage are temporary and will be lost when Shep closes.' : null;
    case 'get_computer_name': return 'Local preview';
    case 'get_home_directory': return '/preview';
    case 'git_status': return {...git,worktree_parent:String(args?.path).includes('.shep-worktrees/shep/') ? 'shep' : null,dirty:repoChanges.length > 0,unstaged:repoChanges.filter(file => file.area === 'unstaged').length,untracked:repoChanges.filter(file => file.area === 'untracked').length};
    case 'is_git_repo': return true;
    case 'git_current_branch': return git.branch;
    case 'git_changed_files': return repoChanges;
    case 'git_changes':
    case 'git_diff_stats': {
      const scale = params.get('changes') === 'large' ? 1000 : 1;
      const stats = repoChanges.map((file, i) => ({path:file.path,additions:[48,24,8,3,16][i]*scale,deletions:[12,9,1,1,0][i]*scale}));
      const result = cmd === 'git_changes' ? {files:repoChanges,stats,statsComplete:true} : stats;
      return params.has('delay') && args?.path === '/preview/shep'
        ? new Promise(resolve => setTimeout(() => resolve(result), 2000)) : result;
    }
    case 'git_list_files': return changedFiles.map(file => file.path);
    case 'git_file_contents': return previewFile;
    case 'read_markdown_file': return '# Shep\n\nRun coding agents and terminals **side by side**.\n\n- Projects and groups\n- Chat or terminal agents\n\n```sh\npnpm tauri dev\n```\n';
    case 'git_file_diff': return `diff --git a/${args?.filePath} b/${args?.filePath}\nindex 1111111..2222222 100644\n--- a/${args?.filePath}\n+++ b/${args?.filePath}\n@@ -1,3 +1,3 @@\n export default function App() {\n-  return <main>Welcome</main>;\n+  return <main>Start an agent.</main>;\n }\n`;
    case 'get_models_for_provider': return ['Default model', 'Fast model', 'Reasoning model'];
    case 'list_listening_ports': {
      portScans++;
      if (params.get('ports') === 'error' && portScans === 1) return Promise.reject('Unable to read listening processes.');
      if (params.get('ports') === 'slow' && portScans === 1) return new Promise(resolve => setTimeout(() => resolve(previewPorts), 2000));
      return previewPorts;
    }
    case 'kill_port': previewPorts = previewPorts.filter(port => port.pid !== args?.pid); return null;
    case 'open_url': document.documentElement.dataset.previewLastOpenedUrl = String(args?.url); return null;
    case 'reveal_in_finder': document.documentElement.dataset.previewLastRevealed = String(args?.path); return null;
    case 'read_chat_image': {
      const path = String(args?.path);
      if (path.includes('missing')) return Promise.reject('missing');
      if (path.includes('huge')) return Promise.reject('too-large');
      // A 1×1 PNG.
      return Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), c => c.charCodeAt(0)).buffer;
    }
    case 'get_pi_config': return {settings:{defaultProvider:null,defaultModel:null},configuredProviders:[]};
    case 'get_all_usage_snapshots': return snapshots;
    case 'list_session_history': {
      historyScans++;
      if (params.get('history') === 'error' && historyScans === 1) return Promise.reject('Unable to read saved conversations.');
      return histories.filter(item => (!args?.projectPath || item.projectPath === args.projectPath) &&
        (!args?.query || [item.title,item.provider,item.projectPath,item.model].join(' ').toLowerCase().includes(String(args.query).toLowerCase()))).slice(0, Number(args?.limit ?? 200));
    }
    case 'spawn_pty': {
      document.documentElement.dataset.previewLastSession = JSON.stringify({command:args?.command,args:args?.args,cwd:args?.cwd});
      if (params.get('pty') === 'exit') (args?.onData as any).onmessage({event:'exit',data:{code:0}});
      return ++previewPtyId;
    }
    case 'get_usage_overview': return usageOverview(String(args?.window ?? '24h'));
    case 'get_memory_stats': return {app_rss:100000000,children_rss:0};
    case 'resolve_session_title': case 'get_agent_runtime_status': return null;
    default: return [];
  }
}, {shouldMockEvents:true});
useRepoStore.setState({ repos, activeRepoPath: repos[0].path, activeConfig: config });
useTerminalStore.getState().switchProject(repos[0].path);
useUsageSettingsStore.setState({settings:{...useUsageSettingsStore.getState().settings,antigravity:{show:false,budgetMode:'subscription',monthlyBudget:null},grok:{show:false,budgetMode:'subscription',monthlyBudget:null},opencode:{show:false,budgetMode:'custom',monthlyBudget:null}}});
for (let i = 0; i < 2; i++) {
  const id = 900 + i;
  useTerminalStore.getState().addTab({id:`preview-${id}`,kind:'assistant',label:i ? 'Keyboard navigation' : 'Workspace design',labelSource:'user',ptyId:id,agentInterface:'chat',repoPath:repos[0].path,commandName:null,assistantId:i ? 'codex' : 'claude',providerSessionId:i ? null : 'sample-0',sessionMode:'standard'});
  if (!i) {
    useTerminalStore.getState().initActivity(id);
    useTerminalStore.getState().setTabAgentState(id, {state:'idle',updatedAt:now,source:'provider',reason:'Waiting for a prompt',ruleId:null});
  }
  useChatStore.getState().init(id);
  useChatStore.getState().update(id, () => ({...emptyChat(),status:'ready',commands:[{name:'compact',description:'Summarize this conversation'}],options:[{id:'model',name:'Model',value:'default',source:'model',choices:[{value:'default',name:i ? 'Codex' : 'Claude Code'}]}],turns:[{id:0,prompt:'Bring the workspace closer to Springroll. Keep it calm and easy to scan.',startedAt:now-47000,endedAt:now,stopReason:'end_turn',items:[{kind:'tool',id:'read',title:'Read workspace styles',toolKind:'read',status:'completed',output:'Read src/styles/globals.css',diffs:[]},{kind:'message',id:'answer',messageId:null,text:'The workspace now has a consistent rhythm.\n\n- **Clearer navigation.** Projects and active agents have distinct places in the sidebar.\n- **Room to read.** Pages share a comfortable width, with quieter controls and more consistent spacing.\n- **One visual language.** Light and dark themes use the same surfaces and type hierarchy.\n\nThe next step is to check the smaller window layouts and keyboard interactions.'}]}]}));
}
useTerminalStore.getState().addPanelTab('launcher');
const previewWidth = Number(params.get('width'));
const previewHeight = Number(params.get('height'));
if (previewWidth >= 800 && previewHeight >= 600) {
  const root = document.getElementById('root')!;
  root.style.width = `${previewWidth}px`;
  root.style.height = `${previewHeight}px`;
}
if (params.get('view') === 'chat') useTerminalStore.getState().setActiveTab('preview-900');
if (params.has('chat')) await startChat({assistant:CODING_ASSISTANTS.find(assistant => assistant.id === (params.get('chat') === 'antigravity' ? 'antigravity' : params.get('chat') === 'cursor' ? 'cursor' : params.get('chat')?.startsWith('pi') ? 'pi' : 'claude'))!,repoPath:repos[0].path,mode:params.get('access') === 'ask' ? 'standard' : 'yolo'});
if (params.get('view') === 'ports') useUIStore.getState().togglePortsPanel();
if (params.get('view') === 'usage') useUIStore.getState().toggleUsagePanel();
if (params.get('view') === 'history') useUIStore.getState().toggleHistoryPanel();
if (params.get('view') === 'projects') useUIStore.getState().toggleProjectsPanel();
if (params.get('view') === 'switcher') useUIStore.getState().setProjectSwitcherOpen(true);
const theme = new URLSearchParams(location.search).get('theme');
if (theme) useThemeStore.getState().setTheme(theme);
// Show the native titlebar's footprint so browser checks catch crowded controls.
// These dots are decorative; the browser preview never changes a native window.
// Rust config is excluded from Vite's watcher; read it fresh on preview reload.
const tauriConfig = await fetch('/src-tauri/tauri.conf.json', {cache:'no-store'}).then(response => response.json());
const trafficLights = tauriConfig.app.windows[0].trafficLightPosition;
if (params.has('cold') || params.has('repos')) {
  useRepoStore.setState({repos:[],activeRepoPath:null,activeConfig:null});
  useTerminalStore.setState({projectState:{},activeProjectPath:null,tabActivity:{}});
}
createRoot(document.getElementById('root')!).render(<>
  <App />
  <div data-preview-traffic-lights aria-hidden="true" style={{position:'absolute',left:trafficLights.x,top:trafficLights.y-6,display:'flex',gap:8,pointerEvents:'none',zIndex:3}}>
    {['#ff5f57','#febc2e','#28c840'].map(color => <span key={color} style={{width:12,height:12,borderRadius:'50%',background:color,boxShadow:'inset 0 0 0 1px #0002'}} />)}
  </div>
</>);
