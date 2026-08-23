import { createBrowserRouter } from 'react-router-dom';
import { HomePage } from './routes/HomePage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <HomePage />,
  },
]);
