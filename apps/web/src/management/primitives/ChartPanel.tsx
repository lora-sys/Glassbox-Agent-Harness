/**
 * @file apps/web/src/management/primitives/ChartPanel.tsx
 *
 * Accessible chart panel adhering strictly to Section 7 & Section 22 of DESIGN.md & DESIGN_EVAL.md:
 * - Differentiates series by line pattern (solid, dashed, dotted) as well as color
 * - Legend with semantic strokes
 * - Accessible numeric/tabular fallback table
 */
import React, { useState } from 'react';

export interface ChartSeries {
  id: string;
  name: string;
  pattern: 'solid' | 'dashed' | 'dotted';
  color: string;
  data: number[];
  plotScale?: number;
}

export function getChartPointCoordinates(
  val: number,
  idx: number,
  length: number,
  maxVal: number,
  usableWidth: number,
  usableHeight: number,
  paddingX: number,
  paddingY: number,
  height: number,
): { x: number; y: number } {
  const x = length <= 1 ? paddingX + usableWidth / 2 : paddingX + (idx / (length - 1)) * usableWidth;
  const safeMax = maxVal > 0 ? maxVal : 1;
  const y = height - paddingY - (val / safeMax) * usableHeight;
  return { x, y };
}

export function getStrokeDasharray(pattern: 'solid' | 'dashed' | 'dotted'): string | undefined {
  switch (pattern) {
    case 'dashed':
      return '6,4';
    case 'dotted':
      return '2,4';
    case 'solid':
    default:
      return undefined;
  }
}

interface ChartPanelProps {
  title: string;
  subtitle?: string;
  categories: string[];
  series: ChartSeries[];
  height?: number;
  className?: string;
}

export const ChartPanel: React.FC<ChartPanelProps> = ({
  title,
  subtitle,
  categories,
  series,
  height = 160,
  className = '',
}) => {
  const [showTableFallback, setShowTableFallback] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Compute maximum value for scaling across plot values (never mutating raw data)
  const allPlotValues = series.flatMap((s) => s.data.map((val) => val * (s.plotScale ?? 1)));
  const maxVal = Math.max(...allPlotValues, 1);

  // Generate SVG path for a series
  const width = 600;
  const paddingX = 30;
  const paddingY = 20;
  const usableWidth = width - paddingX * 2;
  const usableHeight = height - paddingY * 2;

  const getPoints = (s: ChartSeries) => {
    if (s.data.length <= 1) return '';
    const scale = s.plotScale ?? 1;
    return s.data
      .map((val, idx) => {
        const { x, y } = getChartPointCoordinates(
          val * scale,
          idx,
          s.data.length,
          maxVal,
          usableWidth,
          usableHeight,
          paddingX,
          paddingY,
          height,
        );
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  };

  return (
    <div className={`chartPanel ${className}`} role="region" aria-label={title}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: 0 }}>{title}</h3>
          {subtitle && <p style={{ fontSize: 11, color: 'var(--metadata)', margin: '2px 0 0 0' }}>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="btn secondary sm"
          onClick={() => setShowTableFallback(!showTableFallback)}
          aria-label={showTableFallback ? '查看图形视图' : '查看数据表格视图'}
        >
          {showTableFallback ? '折线图' : '表格视图'}
        </button>
      </div>

      <div className="chartLegend">
        {series.map((s) => (
          <div key={s.id} className="chartLegendItem">
            <span
              className={`chartLegendLine ${s.pattern}`}
              style={
                s.pattern === 'solid'
                  ? { backgroundColor: s.color }
                  : {
                      background: `repeating-linear-gradient(90deg, ${s.color} 0 ${s.pattern === 'dashed' ? 4 : 2}px, transparent ${s.pattern === 'dashed' ? 4 : 2}px ${s.pattern === 'dashed' ? 8 : 5}px)`,
                    }
              }
            />
            <span>{s.name} ({s.pattern})</span>
          </div>
        ))}
      </div>

      {showTableFallback ? (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="dataTable">
            <thead>
              <tr>
                <th>时间点 / 标签</th>
                {series.map((s) => (
                  <th key={s.id}>{s.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categories.map((cat, idx) => (
                <tr key={idx}>
                  <td>{cat}</td>
                  {series.map((s) => (
                    <td key={s.id} className="mono">{s.data[idx] ?? '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative', width: '100%', overflowX: 'auto' }}>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            style={{ width: '100%', height, overflow: 'visible' }}
            aria-hidden="true"
          >
            {/* Grid lines */}
            <line x1={paddingX} y1={paddingY} x2={width - paddingX} y2={paddingY} stroke="var(--line)" strokeWidth="1" />
            <line x1={paddingX} y1={height / 2} x2={width - paddingX} y2={height / 2} stroke="var(--line)" strokeWidth="1" />
            <line x1={paddingX} y1={height - paddingY} x2={width - paddingX} y2={height - paddingY} stroke="var(--line)" strokeWidth="1" />

            {/* Series lines */}
            {series.map((s) => (
              <polyline
                key={s.id}
                className="chartLine"
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={getStrokeDasharray(s.pattern)}
                points={getPoints(s)}
              />
            ))}

            {/* Data points */}
            {series.map((s) => {
              const scale = s.plotScale ?? 1;
              return s.data.map((val, idx) => {
                const { x, y } = getChartPointCoordinates(
                  val * scale,
                  idx,
                  s.data.length,
                  maxVal,
                  usableWidth,
                  usableHeight,
                  paddingX,
                  paddingY,
                  height,
                );
                return (
                  <circle
                    key={`${s.id}-${idx}`}
                    className="chartPoint"
                    cx={x}
                    cy={y}
                    r={hoverIndex === idx ? 5 : 3}
                    fill={s.color}
                    stroke="var(--surface)"
                    strokeWidth="1.5"
                    style={{ cursor: 'pointer', transition: 'r 0.15s ease' }}
                    onMouseEnter={() => setHoverIndex(idx)}
                    onMouseLeave={() => setHoverIndex(null)}
                  />
                );
              });
            })}
          </svg>

          {hoverIndex !== null && categories[hoverIndex] && (
            <div
              className="chartTooltip"
              role="tooltip"
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                background: 'var(--surface)',
                border: '1px solid var(--line-strong)',
                borderRadius: 'var(--radius-sm)',
                padding: '4px 8px',
                fontSize: 11,
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <div>{categories[hoverIndex]}</div>
              {series.map((s) => (
                <div key={s.id} style={{ color: s.color }}>
                  {s.name}: {s.data[hoverIndex]}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
