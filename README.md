# Auth API (Register/Login)

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create `.env`:

```bash
copy .env.example .env
```

Set `JWT_SECRET` to a long random string.

3. Run:

```bash
npm run dev
```

## Endpoints

- `POST /register`
  - body: `{ "email": "a@b.com", "password": "password123" }`
- `POST /login`
  - body: `{ "email": "a@b.com", "password": "password123" }`
  - returns: `{ "token": "..." }`
- `GET /me`
  - header: `Authorization: Bearer <token>`

## Storage

Users are stored in `data.sqlite` with **hashed passwords** (bcrypt).

