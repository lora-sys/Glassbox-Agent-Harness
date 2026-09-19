/**
 * @file apps/web/src/management/primitives/DataTable.tsx
 */
import React from 'react';

export interface Column<T> {
  key: string;
  header: string;
  render: (item: T) => React.ReactNode;
  width?: string | number;
  sortable?: boolean;
}

interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  keyExtractor: (item: T) => string;
  selectedId?: string;
  onRowClick?: (item: T) => void;
  emptyMessage?: string;
  className?: string;
}

export function DataTable<T>({
  data,
  columns,
  keyExtractor,
  selectedId,
  onRowClick,
  emptyMessage = '暂无数据',
  className = '',
}: DataTableProps<T>): React.ReactElement {
  if (data.length === 0) {
    return (
      <div className={`tableContainer ${className}`} style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--metadata)' }}>
        <p style={{ margin: 0, fontSize: 13 }}>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={`tableContainer ${className}`}>
      <table className="dataTable">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={{ width: col.width }}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((item) => {
            const rowKey = keyExtractor(item);
            const isSelected = selectedId === rowKey;
            return (
              <tr
                key={rowKey}
                className={`${onRowClick ? 'clickable' : ''} ${isSelected ? 'selected' : ''}`}
                onClick={() => onRowClick && onRowClick(item)}
                tabIndex={onRowClick ? 0 : undefined}
                aria-selected={onRowClick ? isSelected : undefined}
                onKeyDown={(e) => {
                  if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    onRowClick(item);
                  }
                }}
              >
                {columns.map((col) => (
                  <td key={col.key}>{col.render(item)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
