import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import Nav from './Nav';
import Hero from './Hero';
import Pain from './Pain';
import Workflow from './Workflow';
import Offer from './Offer';

const Landing = () => {
  const navigate = useNavigate();
  const { isAuthenticated, login } = useAuth();

  const handleCta = useCallback(async () => {
    if (isAuthenticated) {
      navigate('/dashboard');
      return;
    }
    try {
      await login(true);
    } catch {
      navigate('/login');
    }
  }, [isAuthenticated, login, navigate]);

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased selection:bg-primary-100 selection:text-primary-900">
      <Nav onCtaClick={handleCta} />
      <main>
        <Hero onCtaClick={handleCta} />
        <Pain />
        <Workflow />
        <Offer onCtaClick={handleCta} />
      </main>
    </div>
  );
};

export default Landing;
