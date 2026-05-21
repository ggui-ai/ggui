import type { PaginationProps } from './types';
import { Button } from '../primitives/Button';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * Pagination - Page navigation controls
 */
export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  showFirstLast = true,
  maxVisible = 5,
  size = 'md',
  disabled,
  style,
  className,
}: PaginationProps) {
  // Calculate visible page numbers
  const getVisiblePages = () => {
    const pages: (number | 'ellipsis')[] = [];

    if (totalPages <= maxVisible) {
      // Show all pages
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      // Always show first page
      pages.push(1);

      // Calculate range around current page
      const halfVisible = Math.floor((maxVisible - 3) / 2);
      let startPage = Math.max(2, currentPage - halfVisible);
      let endPage = Math.min(totalPages - 1, currentPage + halfVisible);

      // Adjust if we're near the beginning
      if (currentPage <= halfVisible + 2) {
        endPage = Math.min(totalPages - 1, maxVisible - 2);
      }

      // Adjust if we're near the end
      if (currentPage >= totalPages - halfVisible - 1) {
        startPage = Math.max(2, totalPages - maxVisible + 3);
      }

      // Add ellipsis or pages
      if (startPage > 2) {
        pages.push('ellipsis');
      }

      for (let i = startPage; i <= endPage; i++) {
        pages.push(i);
      }

      if (endPage < totalPages - 1) {
        pages.push('ellipsis');
      }

      // Always show last page
      pages.push(totalPages);
    }

    return pages;
  };

  const buttonSize = size === 'sm' ? 'xs' : size === 'lg' ? 'md' : 'sm';
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 20 : 16;

  const PageButton = ({ page, active }: { page: number; active?: boolean }) => (
    <button
      onClick={() => !disabled && onPageChange?.(page)}
      disabled={disabled}
      style={{
        minWidth: size === 'sm' ? '28px' : size === 'lg' ? '40px' : '32px',
        height: size === 'sm' ? '28px' : size === 'lg' ? '40px' : '32px',
        padding: '0 8px',
        border: 'none',
        borderRadius: '6px',
        backgroundColor: active ? colors.primary[600] : 'transparent',
        color: active ? colors.white : colors.gray[700],
        fontSize: size === 'sm' ? fontSize.xs : fontSize.sm,
        fontWeight: active ? fontWeight.medium : fontWeight.normal,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'all 0.15s',
      }}
    >
      {page}
    </button>
  );

  return (
    <nav
      aria-label="Pagination"
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        ...style,
      }}
    >
      {showFirstLast && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={() => onPageChange?.(1)}
          disabled={disabled || currentPage === 1}
          aria-label="First page"
        >
          <Icon name="chevron-left" size={iconSize} />
          <Icon name="chevron-left" size={iconSize} style={{ marginLeft: '-8px' }} />
        </Button>
      )}
      <Button
        variant="ghost"
        size={buttonSize}
        onClick={() => onPageChange?.(currentPage - 1)}
        disabled={disabled || currentPage === 1}
        aria-label="Previous page"
      >
        <Icon name="chevron-left" size={iconSize} />
      </Button>

      {getVisiblePages().map((page, index) =>
        page === 'ellipsis' ? (
          <span
            key={`ellipsis-${index}`}
            style={{
              padding: '0 4px',
              color: colors.gray[400],
            }}
          >
            ...
          </span>
        ) : (
          <PageButton key={page} page={page} active={page === currentPage} />
        )
      )}

      <Button
        variant="ghost"
        size={buttonSize}
        onClick={() => onPageChange?.(currentPage + 1)}
        disabled={disabled || currentPage === totalPages}
        aria-label="Next page"
      >
        <Icon name="chevron-right" size={iconSize} />
      </Button>
      {showFirstLast && (
        <Button
          variant="ghost"
          size={buttonSize}
          onClick={() => onPageChange?.(totalPages)}
          disabled={disabled || currentPage === totalPages}
          aria-label="Last page"
        >
          <Icon name="chevron-right" size={iconSize} />
          <Icon name="chevron-right" size={iconSize} style={{ marginLeft: '-8px' }} />
        </Button>
      )}
    </nav>
  );
}
