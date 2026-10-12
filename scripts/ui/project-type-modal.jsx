import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CenterMorphModal } from './components/center-morph-modal.jsx';

export function ProjectTypeModal({ options, onComplete, origin, getOrigin }) {
  const [open, setOpen] = useState(true);
  const selected = useRef(null);
  const finish = (value = '') => {
    if (selected.current !== null) return;
    selected.current = value;
    setOpen(false);
  };
  return <CenterMorphModal open={open} onClose={() => finish()} ariaLabel="创建项目" origin={origin} getOrigin={getOrigin}
    onExitComplete={() => onComplete(selected.current || '')}>
    <div className="project-type-content">
      <header><div><h2>创建项目</h2><p>选择适合这次创作的方式</p></div><button type="button" className="project-type-close" aria-label="关闭" onClick={() => finish()}>
        <span className="gugu-lucide gugu-lucide-x" aria-hidden="true" />
      </button></header>
      <div className="project-type-options">{options.map(({ type, label, description, icon }) =>
        <button key={type} type="button" className="project-type-option" data-project-type={type} onClick={() => finish(type)}>
          <span className={`project-type-preview project-type-preview-${type}`} aria-hidden="true">
            {type === 'canvas' ? <><span className="project-type-preview-link" /><i /><i /><i /></> : <><span className="project-type-preview-film"><i /><i /><i /></span><span className="project-type-preview-timeline"><i /><i /><i /></span></>}
          </span>
          <span className="project-type-copy"><span className="project-type-name"><span className="project-type-icon" aria-hidden="true"><span className={`gugu-lucide gugu-lucide-${icon}`} /></span><strong>{label}</strong></span><small>{description}</small></span>
        </button>
      )}</div>
    </div>
  </CenterMorphModal>;
}

let active = false;
export function openProjectTypeModal(options, { origin, getOrigin } = {}) {
  if (active) return Promise.resolve('');
  active = true;
  const restore = document.activeElement;
  const host = document.createElement('div');
  host.className = 'project-type-modal-host';
  document.body.append(host);
  const root = createRoot(host);
  return new Promise(resolve => {
    root.render(<ProjectTypeModal options={options} origin={origin} getOrigin={getOrigin} onComplete={value => {
      queueMicrotask(() => {
        root.unmount(); host.remove(); active = false;
        if (!value && restore?.isConnected) restore.focus({ preventScroll: true });
        resolve(value);
      });
    }} />);
  });
}
