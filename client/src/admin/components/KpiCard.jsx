import React from 'react';
import AdminIcon from './AdminIcons';

export default function KpiCard({ label, value, sublabel, icon = 'grid', tone = 'neutral' }) {
  return (
    <article className={`adm-kpi adm-kpi--${tone}`}>
      <div className="adm-kpi__head">
        <span className="adm-kpi__label">{label}</span>
        <span className={`adm-kpi__icon adm-kpi__icon--${tone}`}>
          <AdminIcon name={icon} size={18} />
        </span>
      </div>
      <div className="adm-kpi__value">{value}</div>
      {sublabel && <div className="adm-kpi__sub">{sublabel}</div>}
    </article>
  );
}
