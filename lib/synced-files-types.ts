/**
 * Tree shape shared between sidebar.tsx and synced-files.ts.
 * Mirrors the TreeNode currently inlined in sidebar.tsx.
 */

export interface FolderTreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  handle: FileSystemFileHandle | FileSystemDirectoryHandle;
  children?: FolderTreeNode[];
  isText?: boolean;
  isImage?: boolean;
}
