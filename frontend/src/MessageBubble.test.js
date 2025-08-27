jest.mock('wavesurfer.js', () => ({}));

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
