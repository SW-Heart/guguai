import { createRoot } from 'react-dom/client';
import { TiltCard } from './components/tilt-card.jsx';
export { openProjectTypeModal } from './project-type-modal.jsx';

export function CreateProjectCard({ onCreate }) {
  return <TiltCard max={6} glare={false} className="create-home-tilt-card">
    <button type="button" className="create-home-primary" data-home-create="" onClick={event => onCreate?.(event.currentTarget)}>
      <span className="create-home-canvases" aria-hidden="true">
        <span className="create-home-sheet create-home-sheet-back" data-project-mode="smart">
          <span className="project-card-art"><i /><i /><i /></span>
        </span>
        <span className="create-home-sheet create-home-sheet-middle" data-project-mode="professional">
          <span className="project-card-art"><i /><i /><i /></span>
        </span>
        <span className="create-home-sheet create-home-sheet-front"><span className="gugu-lucide gugu-lucide-plus" /></span>
      </span>
      <span className="create-home-primary-copy">
        <span className="create-home-primary-title">创建项目</span>
        <span className="create-home-primary-caption">从一个想法，开始新的作品</span>
      </span>
    </button>
  </TiltCard>;
}

export function mountCreateProjectCard(host, { signal, onCreate } = {}) {
  if (signal?.aborted) return () => {};
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener('abort', dispose);
    root.unmount();
  };
  signal?.addEventListener('abort', dispose, { once: true });
  root.render(<CreateProjectCard onCreate={trigger => { if (!disposed) onCreate?.(trigger); }} />);
  return dispose;
}
