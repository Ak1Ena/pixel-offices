import { FolderPicker } from './FolderPicker.js';
import { Button } from './ui/Button.js';

interface FolderFieldProps {
  value: string;
  onChange: (path: string) => void;
  /** Recent and workspace folders, newest first: one-click picks. */
  folders: string[];
  /** The folder browser needs the server's listFolder (standalone, tokened page). */
  canBrowse: boolean;
  /** Offer "No folder" (the folder is optional). */
  optional?: boolean;
}

/**
 * A project folder, chosen the way + Agent chooses one: the folder browser
 * where the server can list folders, else a path field with the known folders
 * as one-click picks (VS Code panel, untokened page).
 */
export function FolderField({ value, onChange, folders, canBrowse, optional }: FolderFieldProps) {
  const clear = optional && value.trim() !== '' && (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="self-start"
      onClick={() => onChange('')}
    >
      No folder
    </Button>
  );
  if (canBrowse) {
    return (
      <div className="flex flex-col gap-4">
        <FolderPicker value={value} onChange={onChange} recentFolders={folders} />
        {clear}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder="~/code/my-project"
        className="bg-bg-dark border-2 border-border px-6 py-2 text-sm text-text font-mono"
      />
      {folders.length > 0 && (
        <span className="flex gap-4 flex-wrap">
          {folders.slice(0, 5).map((f) => (
            <Button
              key={f}
              type="button"
              size="sm"
              variant={value.trim() === f ? 'active' : 'default'}
              title={f}
              onClick={() => onChange(f)}
            >
              {f.split(/[\\/]/).filter(Boolean).pop() ?? f}
            </Button>
          ))}
        </span>
      )}
      {clear}
    </div>
  );
}
