/**
 * Agent Listing types for the agent marketplace.
 *
 * AgentListings represent published agents that appear in the
 * browse/marketplace panel.
 */

export type AgentListingVisibility = 'public' | 'private' | 'restricted';
export type AgentListingStatus = 'draft' | 'published' | 'suspended';

export interface AgentListingItem {
  id: string;
  appId: string;
  ownerId: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  iconUrl?: string;
  visibility: AgentListingVisibility;
  status: AgentListingStatus;
  featured?: boolean;
  usageCount?: number;
  createdAt: string;
}
