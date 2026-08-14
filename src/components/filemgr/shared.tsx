import { useRef, useState, useEffect } from 'react';
import { useI18n } from '../../i18n';
import { resolveIdbUrl } from '../../data/idb';

/** Selection is id-based so it never goes stale after the library reloads. */
export type Selection =
  | { kind: 'album'; albumId: string }
  | { kind: 'song'; albumId: string; songId: string }
  | { kind: 'diff'; albumId: string; songId: string; index: number }
  | null;

interface FileFieldProps {
  label: string;
  accept: string;
  value?: string;
  onFile: (file: File) => void;
}

function shortName(value?: string): string {
  if (!value) return '';
  if (value.startsWith('idb://')) return '✓ ' + value.slice('idb://'.length);
  const parts = value.split('/');
  return parts[parts.length - 1];
}

export function FileField({ label, accept, value, onFile }: FileFieldProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string>('');

  useEffect(() => {
    let active = true;
    if (!value) {
      setPreview('');
    } else if (value.startsWith('idb://')) {
      resolveIdbUrl(value)
        .then((u) => {
          if (active) setPreview(u);
        })
        .catch(() => active && setPreview(''));
    } else if (/^https?:/.test(value)) {
      setPreview(value);
    } else {
      setPreview('');
    }
    return () => {
      active = false;
    };
  }, [value]);

  return (
    <div className="mb-3">
      <div className="text-xs text-[#9fb4c7] mb-1.5 font-orbitron tracking-wide">{label}</div>
      <div className="flex items-center gap-3">
        {preview && accept.startsWith('image') && (
          <img
            src={preview}
            alt=""
            className="w-14 h-14 rounded-lg object-cover border border-white/10 shadow-[0_0_12px_rgba(34,211,238,0.25)]"
          />
        )}
        {preview && accept.startsWith('audio') && (
          <div className="w-14 h-14 rounded-lg border border-white/10 bg-white/5 flex items-center justify-center text-cyan-300">
            <span className="text-lg">♪</span>
          </div>
        )}
        <button
          type="button"
          className="glass-btn text-xs px-3 py-1.5"
          onClick={() => inputRef.current?.click()}
        >
          {t('filemgr.choose')}…
        </button>
        <span className="text-[11px] text-[#6b7f93] truncate max-w-[160px]">
          {value ? shortName(value) : t('filemgr.none')}
        </span>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

export function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string;
  value: string | number;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="mb-3">
      <div className="text-xs text-[#9fb4c7] mb-1.5 font-orbitron tracking-wide">{label}</div>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full glass-input text-sm px-3 py-2 rounded-lg"
      />
    </div>
  );
}

export function CoverThumb({ src, className = '' }: { src?: string; className?: string }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true;
    if (!src) {
      setUrl('');
    } else if (src.startsWith('idb://')) {
      resolveIdbUrl(src)
        .then((u) => active && setUrl(u))
        .catch(() => active && setUrl(''));
    } else if (/^https?:/.test(src)) {
      setUrl(src);
    } else {
      setUrl('');
    }
    return () => {
      active = false;
    };
  }, [src]);
  if (!url) {
    return (
      <div className={`${className} bg-white/5 flex items-center justify-center text-[#6b7f93] text-[10px]`}>
        —
      </div>
    );
  }
  return <img src={url} alt="" className={`${className} object-cover`} />;
}
