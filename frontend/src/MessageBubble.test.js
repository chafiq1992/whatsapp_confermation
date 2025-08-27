jest.mock('wavesurfer.js', () => ({}));
require('@testing-library/jest-dom');

const React = require('react');
const { render, screen } = require('@testing-library/react');
const MessageBubble = require('./MessageBubble').default;
const { getSafeMediaUrl } = require('./MessageBubble');

describe('getSafeMediaUrl', () => {
  it('rewrites /app/ paths to /media/', () => {
    expect(getSafeMediaUrl('/app/media/foo.ogg')).toBe('/media/foo.ogg');
  });

  it('prefixes relative paths with the API base URL', () => {
    process.env.REACT_APP_API_BASE = 'https://api.example.com';
    expect(getSafeMediaUrl('/media/foo.ogg')).toBe('https://api.example.com/media/foo.ogg');
  });
});

describe('MessageBubble audio handling', () => {
  it('shows error when audio url is missing', async () => {
    render(<MessageBubble msg={{ type: 'audio' }} self={false} />);
    expect(await screen.findByText(/Audio URL missing/i)).toBeInTheDocument();
  });
});
