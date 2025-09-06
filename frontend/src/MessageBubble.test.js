jest.mock('wavesurfer.js', () => ({}));
require('@testing-library/jest-dom');

const React = require('react');
const { render, screen } = require('@testing-library/react');
const MessageBubble = require('./MessageBubble').default;
const { getSafeMediaUrl } = require('./MessageBubble');

describe('getSafeMediaUrl', () => {
  it('returns only absolute or blob/data URLs', () => {
    expect(getSafeMediaUrl('https://cdn.example.com/x.jpg')).toBe('https://cdn.example.com/x.jpg');
    const blob = 'blob://local';
    expect(getSafeMediaUrl(blob)).toBe(blob);
    expect(getSafeMediaUrl('/app/media/foo.ogg')).toBe('');
    expect(getSafeMediaUrl('/media/foo.ogg')).toBe('');
  });
});

describe('MessageBubble audio handling', () => {
  it('shows error when audio url is missing', async () => {
    render(<MessageBubble msg={{ type: 'audio' }} self={false} />);
    expect(await screen.findByText(/Audio URL missing/i)).toBeInTheDocument();
  });
});
