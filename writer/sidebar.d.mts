export type StaticSidebarItem = { text: string; link: string; collapsed: boolean; external: boolean; items: StaticSidebarItem[] };
export type StaticVocsConfig = {
  title: string;
  description: string;
  srcDir: string;
  logoUrl: string;
  iconUrl: string;
  banner?: unknown;
  accentColor: string;
  colorScheme: string;
  sidebar: StaticSidebarItem[];
  topNav: StaticSidebarItem[];
};
export function parseSidebar(source: string): StaticSidebarItem[];
export function parseVocsConfig(source: string): StaticVocsConfig;
