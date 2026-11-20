import React from 'react';

export default function Badge({ tone = 'neutral', children, className = '' }) {
  return <span className={`adm-badge adm-badge--${tone} ${className}`.trim()}>{children}</span>;
}

export function statusBadgeTone(status) {
  switch (String(status || '').toUpperCase()) {
    case 'PAID':
    case 'SUCCESS':
    case 'PLAYING':
      return 'success';
    case 'PENDING':
    case 'LOBBY':
      return 'warning';
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function gameBadgeTone(game) {
  switch (game) {
    case 'ludo':
      return 'brand';
    case 'quiz':
      return 'purple';
    case 'chess':
      return 'info';
    case 'snakes':
      return 'success';
    default:
      return 'neutral';
  }
}
