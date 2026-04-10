import { render, act } from '@testing-library/react';
import { screen, fireEvent, waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { UserRoleForm } from '../../../components/user/user-role-form';
import { TestWrapper } from '../../utils';

describe('UserRoleForm', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders form elements correctly', async () => {
    await act(async () => {
      render(<UserRoleForm userId="test-user" initialRole="Staff" />, { wrapper: TestWrapper });
    });
    expect(screen.getByTestId('role-select')).toHaveValue('Staff');
  });

  it('handles role change', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: 'Role updated successfully' })
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await act(async () => {
      render(<UserRoleForm userId="test-user" initialRole="staff" />, { wrapper: TestWrapper });
    });
    
    await act(async () => {
      await userEvent.click(screen.getByText('Administrator'));
    });
    
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/admin/users/test-user/role',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'administrator' })
        })
      );
    });
  });

  it('submits role update successfully', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: 'Role updated successfully' })
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await act(async () => {
      render(<UserRoleForm userId="test-user" initialRole="staff" />, { wrapper: TestWrapper });
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Administrator'));
    });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/admin/users/test-user/role',
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'administrator' })
        })
      );
    });
  });

  it('handles API error response', async () => {
    // Mock alert function
    const mockAlert = jest.fn();
    global.alert = mockAlert;
    
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Invalid role')
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await act(async () => {
      render(<UserRoleForm userId="test-user" initialRole="staff" />, { wrapper: TestWrapper });
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Administrator'));
    });

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith('Failed to update role');
    });
  });

  it('handles network error', async () => {
    // Mock alert function
    const mockAlert = jest.fn();
    global.alert = mockAlert;
    
    const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
    global.fetch = mockFetch as unknown as typeof fetch;

    await act(async () => {
      render(<UserRoleForm userId="test-user" initialRole="staff" />, { wrapper: TestWrapper });
    });

    await act(async () => {
      await userEvent.click(screen.getByText('Administrator'));
    });

    await waitFor(() => {
      expect(mockAlert).toHaveBeenCalledWith('Failed to update role');
    });
  });

  it('disables select while loading', async () => {
    const mockFetch = jest.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
    global.fetch = mockFetch as unknown as typeof fetch;

    await act(async () => {
      render(<UserRoleForm userId="test-user" initialRole="staff" />, { wrapper: TestWrapper });
    });

    const select = screen.getByTestId('role-select');

    await act(async () => {
      await userEvent.click(screen.getByText('Administrator'));
    });
    
    // Check that the select is disabled during the API call
    expect(select).toBeDisabled();
  });
}); 