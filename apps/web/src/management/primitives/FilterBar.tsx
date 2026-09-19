/**
 * @file apps/web/src/management/primitives/FilterBar.tsx
 */
import React from 'react';

interface FilterOption {
  value: string;
  label: string;
}

interface FilterBarProps {
  searchValue?: string;
  onSearchChange?: (val: string) => void;
  searchPlaceholder?: string;
  selectOptions?: Array<{
    id: string;
    value: string;
    onChange: (val: string) => void;
    options: FilterOption[];
    ariaLabel?: string;
  }>;
  resultCount?: number;
  actions?: React.ReactNode;
}

export const FilterBar: React.FC<FilterBarProps> = ({
  searchValue,
  onSearchChange,
  searchPlaceholder = '搜索...',
  selectOptions,
  resultCount,
  actions,
}) => (
  <div className="filterBar" role="search">
    {onSearchChange !== undefined && (
      <input
        type="search"
        className="filterInput"
        placeholder={searchPlaceholder}
        value={searchValue || ''}
        onChange={(e) => onSearchChange(e.target.value)}
        aria-label={searchPlaceholder}
      />
    )}
    {selectOptions?.map((select) => (
      <select
        key={select.id}
        className="filterSelect"
        value={select.value}
        onChange={(e) => select.onChange(e.target.value)}
        aria-label={select.ariaLabel || 'Filter'}
      >
        {select.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    ))}
    {actions}
    {resultCount !== undefined && (
      <span className="filterCount" aria-live="polite">
        共 {resultCount} 项
      </span>
    )}
  </div>
);
