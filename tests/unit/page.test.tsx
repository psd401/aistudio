import { render } from '@testing-library/react'
import { screen } from '@testing-library/dom';
import Home from '@/app/(public)/page';

// Mock aws-amplify
jest.mock('aws-amplify/auth', () => ({
  signIn: jest.fn()
}));

describe('Home', () => {
  it('renders a heading', () => {
    render(<Home />);
    const heading = screen.getByText(/Welcome to AI Studio/i);
    expect(heading).toBeInTheDocument();
  });
}); 