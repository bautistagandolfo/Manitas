import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

function App() {
  return (
    <MantineProvider>
      <Notifications />
      <RouterProvider router={router} />
    </MantineProvider>
  );
}

export default App;
