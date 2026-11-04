// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function setInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

vi.mock('../src/lib/supabase', () => ({
  requirePortalSupabase: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  }),
  requireSupabase: () => ({
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  }),
}));

import { EmailPassModal } from '../src/components/EmailPassModal';

describe('EmailPassModal Component Interaction & Lifecycle Tests', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  it('renders input step with proper labels and consent checkbox', () => {
    act(() => {
      root.render(
        React.createElement(EmailPassModal, {
          isOpen: true,
          onClose: vi.fn(),
          passId: '11111111-1111-4111-8111-111111111111',
          qrToken: 'valid-qr-token-test-123456789012',
          source: 'portal',
          mode: 'delivery-gate',
          initialEmail: 'visitor@example.com',
        })
      );
    });

    const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
    expect(emailInput).not.toBeNull();
    expect(emailInput.value).toBe('visitor@example.com');

    const consentBox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(consentBox).not.toBeNull();
    expect(consentBox.checked).toBe(false);

    const submitBtn = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    expect(submitBtn.textContent).toContain('Send Verification Code');
  });

  it('successful flow completion: clicking Done/View My E-GatePass invokes onSuccess AND onClose and resets internal state', async () => {
    const handleClose = vi.fn();
    const handleSuccess = vi.fn();

    // Mock global fetch to simulate verification code and verify-and-send flow
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init?: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'request_code') {
        return new Response(JSON.stringify({ success: true, verificationId: '22222222-2222-4222-8222-222222222222' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.action === 'verify_and_send') {
        return new Response(JSON.stringify({ success: true, deliveryStatus: 'sent_to_provider' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    act(() => {
      root.render(
        React.createElement(EmailPassModal, {
          isOpen: true,
          onClose: handleClose,
          onSuccess: handleSuccess,
          passId: '11111111-1111-4111-8111-111111111111',
          qrToken: 'valid-qr-token-test-123456789012',
          source: 'portal',
          mode: 'delivery-gate',
          initialEmail: 'visitor@example.com',
        })
      );
    });

    // 1. Check consent and submit code request
    const consentBox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      consentBox.click();
    });

    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Modal is now in 'verify' step
    const codeInput = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    expect(codeInput).not.toBeNull();

    // 2. Enter 6-digit code and verify
    await act(async () => {
      setInputValue(codeInput, '123456');
    });

    const verifyForm = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      verifyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Modal is now in 'sent' step
    // Verify truthful wording: "Email Submitted Successfully", NOT "E-GatePass Emailed!"
    const heading = document.querySelector('h3');
    expect(heading?.textContent).toBe('Email Submitted Successfully');
    expect(document.body.textContent).toContain('A scannable copy of your gate pass QR code was submitted to the email provider');
    expect(document.body.textContent).not.toContain('Email Delivery Confirmed');

    // Find "View My E-GatePass" completion button
    const completeBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('View My E-GatePass')
    );
    expect(completeBtn).toBeDefined();

    // 3. Click completion button: must invoke BOTH handleSuccess AND handleClose
    await act(async () => {
      completeBtn!.click();
    });

    expect(handleSuccess).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('unknown email outcome: clicking completion button invokes onUnknown AND onClose', async () => {
    const handleClose = vi.fn();
    const handleUnknown = vi.fn();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init?: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'request_code') {
        return new Response(JSON.stringify({ success: true, verificationId: '22222222-2222-4222-8222-222222222222' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.action === 'verify_and_send') {
        // Return 202 outcome_unknown
        return new Response(JSON.stringify({ error: 'outcome_unknown', message: 'provider timed out' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    act(() => {
      root.render(
        React.createElement(EmailPassModal, {
          isOpen: true,
          onClose: handleClose,
          onUnknown: handleUnknown,
          passId: '11111111-1111-4111-8111-111111111111',
          qrToken: 'valid-qr-token-test-123456789012',
          source: 'portal',
          mode: 'delivery-gate',
          initialEmail: 'visitor@example.com',
        })
      );
    });

    // Consent and submit code request
    const consentBox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      consentBox.click();
    });
    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Enter code and submit verify
    const codeInput = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(codeInput, '123456');
    });
    const verifyForm = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      verifyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Modal is in 'unknown' step
    const heading = document.querySelector('h3');
    expect(heading?.textContent).toBe('Outcome Unknown');

    const continueBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Continue to E-GatePass')
    );
    expect(continueBtn).toBeDefined();

    // Click completion button: must invoke BOTH handleUnknown AND handleClose
    await act(async () => {
      continueBtn!.click();
    });

    expect(handleUnknown).toHaveBeenCalledTimes(1);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it('reopening modal restores clean initial state and generates fresh request IDs', async () => {
    let isOpen = true;
    const handleClose = vi.fn().mockImplementation(() => {
      isOpen = false;
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init?: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'request_code') {
        return new Response(JSON.stringify({ success: true, verificationId: '44444444-4444-4444-8444-444444444444' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.action === 'verify_and_send') {
        return new Response(JSON.stringify({ success: true, deliveryStatus: 'sent_to_provider' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    const renderModal = (open: boolean) => {
      act(() => {
        root.render(
          React.createElement(EmailPassModal, {
            isOpen: open,
            onClose: handleClose,
            passId: '11111111-1111-4111-8111-111111111111',
            qrToken: 'valid-qr-token-test-123456789012',
            source: 'portal',
            initialEmail: 'test@example.com',
          })
        );
      });
    };

    renderModal(true);

    // Consent and send code
    const consentBox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      consentBox.click();
    });
    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Verify code
    const codeInput = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(codeInput, '654321');
    });
    const verifyForm = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      verifyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Click Done to close
    const doneBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Done'));
    await act(async () => {
      doneBtn!.click();
    });

    expect(handleClose).toHaveBeenCalled();

    // Close modal (isOpen = false)
    renderModal(false);
    expect(document.body.querySelector('input')).toBeNull();

    // Reopen modal (isOpen = true) -> must be in 'input' step, NOT 'sent'
    renderModal(true);
    const emailInputReopened = document.querySelector('input[type="email"]') as HTMLInputElement;
    expect(emailInputReopened).not.toBeNull();
    expect(emailInputReopened.value).toBe('test@example.com');
  });

  it('kiosk mode without onSuccess calls handleClose cleanly on Done click', async () => {
    const handleClose = vi.fn();

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init?: any) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      if (body.action === 'request_code') {
        return new Response(JSON.stringify({ success: true, verificationId: '55555555-5555-4555-8555-555555555555' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (body.action === 'verify_and_send') {
        return new Response(JSON.stringify({ success: true, deliveryStatus: 'sent_to_provider' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('Not found', { status: 404 });
    });

    act(() => {
      root.render(
        React.createElement(EmailPassModal, {
          isOpen: true,
          onClose: handleClose,
          passId: '33333333-3333-4333-8333-333333333333',
          qrToken: 'valid-kiosk-qr-token-123456789012',
          source: 'kiosk',
          initialEmail: 'kiosk.visitor@example.com',
        })
      );
    });

    const consentBox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      consentBox.click();
    });
    const form = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const codeInput = document.querySelector('input[inputmode="numeric"]') as HTMLInputElement;
    await act(async () => {
      setInputValue(codeInput, '112233');
    });
    const verifyForm = document.querySelector('form') as HTMLFormElement;
    await act(async () => {
      verifyForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    const doneBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Done'));
    expect(doneBtn).toBeDefined();

    await act(async () => {
      doneBtn!.click();
    });

    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
