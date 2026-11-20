import React, { useEffect, useId, useRef } from 'react';
import AdminIcon from './AdminIcons';

export default function AdminModal({
  isOpen,
  onClose,
  title,
  subtitle = '',
  size = 'md',
  footer = null,
  children
}) {
  const titleId = useId();
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKeyDown = e => {
      if (e.key === 'Escape') {
        onClose?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const timer = setTimeout(() => {
      dialogRef.current?.focus();
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="adm-modal-backdrop"
      role="presentation"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`adm-modal adm-modal--${size}`}
      >
        <header className="adm-modal__header">
          <div>
            <h2 id={titleId} className="adm-modal__title">
              {title}
            </h2>
            {subtitle && <p className="adm-modal__subtitle">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="adm-icon-btn"
            aria-label="Tutup dialog"
            onClick={onClose}
          >
            <AdminIcon name="x" size={18} />
          </button>
        </header>
        <div className="adm-modal__body">{children}</div>
        {footer && <footer className="adm-modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
