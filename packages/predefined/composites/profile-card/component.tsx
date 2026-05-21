import { useState } from 'react';
import { Card, Stack, Row, Text, Button, Avatar, Divider } from '@ggui-ai/design/primitives';

interface ProfileStats {
  followers: number;
  following: number;
  posts: number;
}

interface ProfileCardCompositeProps {
  name?: string;
  role?: string;
  bio?: string;
  avatarUrl?: string;
  stats?: ProfileStats;
  onFollow?: (isFollowing: boolean) => void;
  onMessage?: () => void;
}

const defaultStats: ProfileStats = {
  followers: 2847,
  following: 382,
  posts: 156,
};

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toString();
}

function StatItem({ label, value }: { label: string; value: number }) {
  return (
    <Stack gap="xs" style={{ alignItems: 'center', flex: 1 }}>
      <Text
        variant="h3"
        style={{
          fontWeight: 700,
          color: 'var(--ggui-color-neutral-900, #171717)',
          margin: 0,
        }}
      >
        {formatCount(value)}
      </Text>
      <Text
        variant="small"
        style={{ color: 'var(--ggui-color-neutral-500, #737373)' }}
      >
        {label}
      </Text>
    </Stack>
  );
}

export default function ProfileCardComposite({
  name = 'Jane Cooper',
  role = 'Product Designer',
  bio = 'Crafting intuitive digital experiences. Passionate about design systems, accessibility, and building products that people love.',
  avatarUrl,
  stats = defaultStats,
  onFollow,
  onMessage,
}: ProfileCardCompositeProps) {
  const [isFollowing, setIsFollowing] = useState(false);
  const [currentStats, setCurrentStats] = useState<ProfileStats>(stats);

  const handleFollow = () => {
    const newFollowing = !isFollowing;
    setIsFollowing(newFollowing);
    setCurrentStats((prev) => ({
      ...prev,
      followers: prev.followers + (newFollowing ? 1 : -1),
    }));
    onFollow?.(newFollowing);
  };

  return (
    <Card
      padding="none"
      style={{
        maxWidth: 380,
        margin: '0 auto',
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid var(--ggui-color-neutral-200, #e5e5e5)',
        boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1)',
      }}
    >
      {/* Cover gradient */}
      <div
        style={{
          height: 100,
          background: 'linear-gradient(135deg, var(--ggui-color-primary-600, #0284c7) 0%, #6366f1 100%)',
        }}
      />

      {/* Avatar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          marginTop: -40,
        }}
      >
        <div
          style={{
            border: '4px solid #ffffff',
            borderRadius: '50%',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
          }}
        >
          <Avatar
            name={name}
            src={avatarUrl}
            size={80}
            shape="circle"
          />
        </div>
      </div>

      {/* Profile Info */}
      <Stack gap="sm" style={{ padding: '16px 24px 0', alignItems: 'center', textAlign: 'center' }}>
        <Text
          variant="h2"
          style={{
            fontWeight: 700,
            color: 'var(--ggui-color-neutral-900, #171717)',
            margin: 0,
          }}
        >
          {name}
        </Text>
        <Text
          variant="body"
          style={{ color: 'var(--ggui-color-primary-600, #0284c7)', fontWeight: 500 }}
        >
          {role}
        </Text>
        {bio && (
          <Text
            variant="small"
            style={{
              color: 'var(--ggui-color-neutral-500, #737373)',
              lineHeight: 1.6,
              maxWidth: 300,
            }}
          >
            {bio}
          </Text>
        )}
      </Stack>

      {/* Stats */}
      <div style={{ padding: '20px 24px' }}>
        <Divider />
        <Row
          justify="center"
          align="center"
          style={{ padding: '16px 0' }}
        >
          <StatItem label="Followers" value={currentStats.followers} />
          <div
            style={{
              width: 1,
              height: 32,
              backgroundColor: 'var(--ggui-color-neutral-200, #e5e5e5)',
            }}
          />
          <StatItem label="Following" value={currentStats.following} />
          <div
            style={{
              width: 1,
              height: 32,
              backgroundColor: 'var(--ggui-color-neutral-200, #e5e5e5)',
            }}
          />
          <StatItem label="Posts" value={currentStats.posts} />
        </Row>
        <Divider />
      </div>

      {/* Actions */}
      <div style={{ padding: '0 24px 24px' }}>
        <Row gap="sm">
          <Button
            variant={isFollowing ? 'secondary' : 'primary'}
            onPress={handleFollow}
            style={{ flex: 1 }}
          >
            {isFollowing ? 'Following' : 'Follow'}
          </Button>
          <Button
            variant="secondary"
            onPress={onMessage}
            style={{ flex: 1 }}
          >
            Message
          </Button>
        </Row>
      </div>
    </Card>
  );
}
