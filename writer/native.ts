import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseSidebar } from './sidebar.mjs';

type NativeProject = { root: string; pagesDir: string; name: string; pages: Array<{path:string;title:string}>; sidebarSource?: string | null };
async function projectResult(promise: Promise<NativeProject | null>) {
  const project = await promise;
  return project ? { ...project, sidebar: project.sidebarSource ? parseSidebar(project.sidebarSource) : [] } : null;
}

if (isTauri()) {
  window.vocsEditorDesktop = {
    chooseProject: () => projectResult(invoke<NativeProject | null>('choose_project')),
    currentProject: () => projectResult(invoke<NativeProject | null>('current_project')),
    listPages: () => invoke('list_pages'),
    readPage: (file) => invoke('read_page', { file }),
    savePage: (file, content) => invoke('save_page', { file, content }),
    preview: (file) => invoke('preview', { file }),
    onPreviewStatus: (listener) => listen<string>('vocs-preview-status', event => listener(event.payload)),
    openFolder: () => invoke('open_folder'),
    openPreview: (url) => invoke('open_preview', { url }),
  };
}
