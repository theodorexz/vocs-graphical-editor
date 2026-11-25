export type SidebarNode = {
  text: string;
  link: string;
  collapsed: boolean;
  external: boolean;
  items: SidebarNode[];
};

export function parseSidebar(source: string): SidebarNode[];
