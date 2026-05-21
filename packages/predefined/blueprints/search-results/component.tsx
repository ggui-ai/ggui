import { useState } from 'react';
import { Container, Card, Stack, Row, Text, Input, Button, Checkbox } from '@ggui-ai/design/primitives';

interface SearchResult {
  id: string;
  title: string;
  snippet: string;
  url?: string;
  source?: string;
  score?: number;
}

interface FacetOption {
  label: string;
  count: number;
  checked: boolean;
}

interface Facet {
  name: string;
  options: FacetOption[];
}

const defaultResults: SearchResult[] = [
  { id: '1', title: 'Getting Started with ggui', snippet: 'Learn how to set up your first AI-powered interface using ggui MCP tools. This guide covers installation, configuration, and your first generation.', source: 'Docs', score: 0.98 },
  { id: '2', title: 'Blueprint-First Architecture', snippet: 'Understanding how ggui prioritizes cached blueprints over generation for faster response times and lower costs.', source: 'Docs', score: 0.92 },
  { id: '3', title: 'WebSocket Connection Guide', snippet: 'How to establish and maintain WebSocket connections for real-time UI updates from agent interactions.', source: 'API Reference', score: 0.87 },
  { id: '4', title: 'Custom Design Tokens', snippet: 'Create custom DTCG design tokens to theme your generated components. Supports light and dark mode with CSS variables.', source: 'Tutorials', score: 0.82 },
  { id: '5', title: 'MCP Server Tools Reference', snippet: 'Complete reference for all MCP tools available to agents: get_primitives, compile_component, validate_component, and more.', source: 'API Reference', score: 0.78 },
];

const defaultFacets: Facet[] = [
  {
    name: 'Source',
    options: [
      { label: 'Docs', count: 12, checked: false },
      { label: 'API Reference', count: 8, checked: false },
      { label: 'Tutorials', count: 5, checked: false },
      { label: 'Blog', count: 3, checked: false },
    ],
  },
  {
    name: 'Type',
    options: [
      { label: 'Guide', count: 10, checked: false },
      { label: 'Reference', count: 9, checked: false },
      { label: 'Example', count: 6, checked: false },
    ],
  },
];

interface SearchResultsProps {
  results?: SearchResult[];
  query?: string;
  facets?: Facet[];
  totalResults?: number;
  onSearch?: (query: string) => void;
  onResultClick?: (result: SearchResult) => void;
  onFacetChange?: (facetName: string, optionLabel: string, checked: boolean) => void;
  onPageChange?: (page: number) => void;
}

export default function SearchResults({
  results = defaultResults,
  query: initialQuery = '',
  facets: initialFacets = defaultFacets,
  totalResults = 28,
  onSearch,
  onResultClick,
  onFacetChange,
  onPageChange,
}: SearchResultsProps) {
  const [searchQuery, setSearchQuery] = useState(initialQuery);
  const [facets, setFacets] = useState(initialFacets);
  const [page, setPage] = useState(1);

  const handleSearch = () => {
    onSearch?.(searchQuery);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleFacetToggle = (facetName: string, optionLabel: string) => {
    setFacets((prev) =>
      prev.map((f) =>
        f.name === facetName
          ? {
              ...f,
              options: f.options.map((o) =>
                o.label === optionLabel ? { ...o, checked: !o.checked } : o
              ),
            }
          : f
      )
    );
    const facet = facets.find((f) => f.name === facetName);
    const option = facet?.options.find((o) => o.label === optionLabel);
    if (option) {
      onFacetChange?.(facetName, optionLabel, !option.checked);
    }
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    onPageChange?.(newPage);
  };

  const totalPages = Math.ceil(totalResults / 5);

  return (
    <Container style={{ maxWidth: 900, margin: '0 auto' }}>
      <Stack gap="md">
        {/* Search Bar */}
        <Card padding="md">
          <Row gap="sm" align="center">
            <div style={{ flex: 1 }} onKeyDown={handleKeyDown}>
              <Input
                placeholder="Search..."
                value={searchQuery}
                onChange={setSearchQuery}
                aria-label="Search"
              />
            </div>
            <Button variant="primary" onPress={handleSearch}>
              Search
            </Button>
          </Row>
          <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #737373)', marginTop: 8 }}>
            {totalResults} results found
          </Text>
        </Card>

        <div style={{ display: 'flex', gap: 20 }}>
          {/* Facet Sidebar */}
          <div style={{ width: 220, flexShrink: 0 }}>
            <Stack gap="md">
              {facets.map((facet) => (
                <Card key={facet.name} padding="md">
                  <Stack gap="sm">
                    <Text variant="body" style={{ fontWeight: 700 }}>{facet.name}</Text>
                    {facet.options.map((option) => (
                      <Row key={option.label} align="center" gap="sm">
                        <Checkbox
                          checked={option.checked}
                          onChange={() => handleFacetToggle(facet.name, option.label)}
                          label=""
                        />
                        <Text variant="small" style={{ flex: 1 }}>{option.label}</Text>
                        <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                          {option.count}
                        </Text>
                      </Row>
                    ))}
                  </Stack>
                </Card>
              ))}
            </Stack>
          </div>

          {/* Results */}
          <div style={{ flex: 1 }}>
            <Stack gap="sm">
              {results.map((result) => (
                <Card
                  key={result.id}
                  padding="md"
                  style={{ cursor: onResultClick ? 'pointer' : 'default' }}
                  onClick={() => onResultClick?.(result)}
                >
                  <Stack gap="xs">
                    <Row justify="between" align="center">
                      <Text
                        variant="body"
                        style={{
                          fontWeight: 600,
                          color: 'var(--ggui-color-primary-600, #0284c7)',
                        }}
                      >
                        {result.title}
                      </Text>
                      {result.score !== undefined && (
                        <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                          {Math.round(result.score * 100)}% match
                        </Text>
                      )}
                    </Row>
                    <Text variant="small" style={{ color: 'var(--ggui-color-neutral-600, #525252)' }}>
                      {result.snippet}
                    </Text>
                    {result.source && (
                      <Text variant="small" style={{ color: 'var(--ggui-color-neutral-400, #a3a3a3)' }}>
                        {result.source}
                      </Text>
                    )}
                  </Stack>
                </Card>
              ))}

              {/* Pagination */}
              {totalPages > 1 && (
                <Row justify="center" gap="sm" style={{ paddingTop: 8 }}>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => handlePageChange(page - 1)}
                    disabled={page <= 1}
                  >
                    Previous
                  </Button>
                  <Text variant="small" style={{ lineHeight: '32px', color: 'var(--ggui-color-neutral-500, #737373)' }}>
                    Page {page} of {totalPages}
                  </Text>
                  <Button
                    variant="outline"
                    size="sm"
                    onPress={() => handlePageChange(page + 1)}
                    disabled={page >= totalPages}
                  >
                    Next
                  </Button>
                </Row>
              )}
            </Stack>
          </div>
        </div>
      </Stack>
    </Container>
  );
}
