const apiBase = '/api';
fetch('/api/session');
axios.get('/v1/orders?mine=true');
axios.post('/graphql', { query: 'query Demo { me { id } }' });
fetch(`${apiBase}/profile`);
