import { useState } from 'react';
import type { CommentThreadProps, Comment } from './types';
import { Avatar } from '../primitives/Avatar';
import { Button } from '../primitives/Button';
import { TextArea } from '../primitives/TextArea';
import { Spinner } from '../primitives/Spinner';
import { colors } from '../tokens/colors';
import { fontSize } from '../tokens/typography';

function CommentItem({
  comment,
  onReply,
  onReaction,
  depth = 0,
}: {
  comment: Comment;
  onReply?: (commentId: string, content: string) => void;
  onReaction?: (commentId: string, emoji: string) => void;
  depth?: number;
}) {
  const [showReplyInput, setShowReplyInput] = useState(false);
  const [replyContent, setReplyContent] = useState('');

  const handleSubmitReply = () => {
    if (replyContent.trim()) {
      onReply?.(comment.id, replyContent);
      setReplyContent('');
      setShowReplyInput(false);
    }
  };

  const timestamp = comment.timestamp instanceof Date
    ? comment.timestamp.toLocaleString()
    : comment.timestamp;

  return (
    <div style={{ marginLeft: depth > 0 ? '40px' : 0 }}>
      <div style={{ display: 'flex', gap: '12px' }}>
        <Avatar
          name={comment.author.name}
          src={comment.author.avatar}
          size="sm"
        />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontWeight: 500, fontSize: fontSize.sm }}>
              {comment.author.name}
            </span>
            <span style={{ color: colors.gray[500], fontSize: fontSize.xs }}>
              {timestamp}
            </span>
          </div>
          <p style={{ margin: '4px 0 8px', fontSize: fontSize.sm, color: colors.gray[700] }}>
            {comment.content}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {comment.reactions?.map((reaction) => (
              <button
                key={reaction.emoji}
                onClick={() => onReaction?.(comment.id, reaction.emoji)}
                style={{
                  padding: '2px 8px',
                  border: `1px solid ${colors.gray[200]}`,
                  borderRadius: '12px',
                  backgroundColor: colors.gray[50],
                  fontSize: fontSize.xs,
                  cursor: 'pointer',
                }}
              >
                {reaction.emoji} {reaction.count}
              </button>
            ))}
            <button
              onClick={() => setShowReplyInput(!showReplyInput)}
              style={{
                background: 'none',
                border: 'none',
                color: colors.gray[500],
                fontSize: fontSize.xs,
                cursor: 'pointer',
              }}
            >
              Reply
            </button>
          </div>
          {showReplyInput && (
            <div style={{ marginTop: '12px' }}>
              <TextArea
                value={replyContent}
                onChange={setReplyContent}
                placeholder="Write a reply..."
                rows={2}
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                <Button size="sm" onClick={handleSubmitReply}>Reply</Button>
                <Button size="sm" variant="ghost" onClick={() => setShowReplyInput(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {comment.replies?.map((reply) => (
        <div key={reply.id} style={{ marginTop: '16px' }}>
          <CommentItem
            comment={reply}
            onReply={onReply}
            onReaction={onReaction}
            depth={depth + 1}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * CommentThread - A threaded comment section with replies and reactions
 */
export function CommentThread({
  comments,
  currentUser,
  onAddComment,
  onReply,
  onReaction,
  loading,
  style,
  className,
}: CommentThreadProps) {
  const [newComment, setNewComment] = useState('');

  const handleSubmit = () => {
    if (newComment.trim()) {
      onAddComment?.(newComment);
      setNewComment('');
    }
  };

  return (
    <div className={className} style={{ ...style }}>
      {currentUser && (
        <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
          <Avatar name={currentUser.name} src={currentUser.avatar} size="sm" />
          <div style={{ flex: 1 }}>
            <TextArea
              value={newComment}
              onChange={setNewComment}
              placeholder="Write a comment..."
              rows={3}
            />
            <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
              <Button onClick={handleSubmit} disabled={!newComment.trim()}>
                Comment
              </Button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '24px' }}>
          <Spinner size={24} />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              onReply={onReply}
              onReaction={onReaction}
            />
          ))}
        </div>
      )}
    </div>
  );
}
